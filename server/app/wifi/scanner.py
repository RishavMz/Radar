"""
WiFi (802.11) network scanner.

Extends BaseScanner with WiFi-specific logic:
- Subprocess scanning via nmcli
- nmcli output parsing and OUI vendor lookup
- ORM persistence to wifi_devices / wifi_history tables

WiFi uses higher speed thresholds than BLE because the nmcli
quality→dBm conversion is lossy, making distance estimates noisier.
"""

import re
import subprocess
import time

from sqlalchemy import delete, select

from app.core.scanner import BaseScanner
from app.core.store import MAX_HISTORY
from app.models.base import db
from app.models.wifi import WifiDevice, WifiHistory

from .metadata import (
    DEFAULT_REF_RSSI,
    freq_to_band,
    oui_vendor,
    parse_nmcli_line,
    quality_to_dbm,
)

_SPEED_STATIONARY = 0.05
_SPEED_FAST = 0.20


class WifiScanner(BaseScanner):
    """WiFi scanner: nmcli-based discovery + ORM persistence."""

    def __init__(self) -> None:
        super().__init__(speed_stationary=_SPEED_STATIONARY, speed_fast=_SPEED_FAST)

    # ── BaseScanner interface ─────────────────────────────────────────────────

    def _ref_rssi(self, _snapshot: dict) -> float:
        return DEFAULT_REF_RSSI

    def _do_scan(
        self, timeout: float, n: float
    ) -> tuple[list[tuple], set[str], float]:
        scan_time = time.time()
        readings: list[tuple] = []
        active: set[str] = set()

        try:
            proc = subprocess.run(
                [
                    "nmcli", "--terse", "--fields",
                    "BSSID,SSID,SIGNAL,FREQ,SECURITY,CHAN",
                    "dev", "wifi", "list", "--rescan", "yes",
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
            if proc.returncode != 0 and not lines:
                raise RuntimeError(proc.stderr.strip() or "nmcli returned no output")
        except FileNotFoundError:
            raise RuntimeError("nmcli not found — install NetworkManager to enable WiFi scanning")
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"WiFi scan timed out after {timeout}s")

        for line in lines:
            parts = parse_nmcli_line(line)
            if len(parts) < 6:
                continue

            bssid_raw, ssid, signal_str, freq_str, security, chan_str = parts[:6]
            bssid = bssid_raw.upper()

            try:
                quality = int(signal_str)
                m = re.search(r'\d+', freq_str)
                freq_mhz = int(m.group()) if m else 0
                channel = int(chan_str) if chan_str.strip().lstrip('-').isdigit() else None
            except (ValueError, AttributeError):
                continue

            rssi = quality_to_dbm(quality)
            # Distance at scan time uses raw RSSI — smoothing happens in _build_results.
            dist = round(10 ** ((DEFAULT_REF_RSSI - rssi) / (10 * n)), 2) if rssi < 0 else None

            snapshot = {
                "bssid":         bssid,
                "ssid":          ssid if ssid.strip() else "Hidden",
                "frequency_mhz": freq_mhz,
                "channel":       channel,
                "band":          freq_to_band(freq_mhz),
                "security":      security if security.strip() and security.strip() != "--" else "Open",
                "vendor":        oui_vendor(bssid),
            }

            active.add(bssid)
            readings.append((bssid, snapshot, rssi, dist, scan_time))

        return readings, active, scan_time

    def _init_store(self) -> None:
        """Load all persisted WiFi access points and their history into the in-memory store."""
        try:
            devices = db.session.execute(db.select(WifiDevice)).scalars().all()
            for dev in devices:
                rows = (
                    db.session.execute(
                        db.select(WifiHistory)
                        .where(WifiHistory.bssid == dev.bssid)
                        .order_by(WifiHistory.recorded_at.asc())
                        .limit(MAX_HISTORY)
                    )
                    .scalars().all()
                )
                self._store.seed(
                    key=dev.bssid,
                    snapshot={
                        "bssid":         dev.bssid,
                        "ssid":          dev.ssid,
                        "frequency_mhz": dev.frequency_mhz,
                        "channel":       dev.channel,
                        "band":          dev.band,
                        "security":      dev.security,
                        "vendor":        dev.vendor,
                    },
                    history=[
                        {"time": r.recorded_at, "rssi": r.rssi, "distance": r.distance}
                        for r in rows
                    ],
                    last_seen=dev.last_seen_at or 0.0,
                )
        except Exception:
            pass  # DB not ready — start with empty store

    def _persist_reading(
        self,
        key: str,
        snapshot: dict,
        rssi: float,
        distance: float | None,
        ts: float,
    ) -> None:
        """Upsert the WiFi device row and insert one history entry (no commit)."""
        try:
            existing = db.session.get(WifiDevice, key)
            if existing is None:
                db.session.add(WifiDevice(
                    bssid=key,
                    ssid=snapshot["ssid"],
                    frequency_mhz=snapshot["frequency_mhz"],
                    channel=snapshot["channel"],
                    band=snapshot["band"],
                    security=snapshot["security"],
                    vendor=snapshot["vendor"],
                    last_seen_at=ts,
                    created_at=ts,
                ))
            else:
                existing.ssid = snapshot["ssid"]
                existing.frequency_mhz = snapshot["frequency_mhz"]
                existing.channel = snapshot["channel"]
                existing.band = snapshot["band"]
                existing.security = snapshot["security"]
                existing.vendor = snapshot["vendor"]
                existing.last_seen_at = ts

            history_row = WifiHistory(bssid=key, rssi=rssi, distance=distance, recorded_at=ts)
            db.session.add(history_row)
            db.session.flush()  # assign ID before trim query

            self._trim_history(key)
        except Exception:
            pass  # non-fatal; in-memory store is authoritative

    def _clear_db(self) -> None:
        """Delete all WiFi records and commit."""
        try:
            db.session.execute(delete(WifiHistory))
            db.session.execute(delete(WifiDevice))
            db.session.commit()
        except Exception:
            db.session.rollback()

    # ── Internal helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _trim_history(bssid: str) -> None:
        """Keep only the most recent MAX_HISTORY rows for this BSSID."""
        keep_ids = (
            select(WifiHistory.id)
            .where(WifiHistory.bssid == bssid)
            .order_by(WifiHistory.recorded_at.desc())
            .limit(MAX_HISTORY)
            .subquery()
        )
        db.session.execute(
            delete(WifiHistory)
            .where(WifiHistory.bssid == bssid)
            .where(WifiHistory.id.notin_(select(keep_ids.c.id)))
            .execution_options(synchronize_session="fetch")
        )
