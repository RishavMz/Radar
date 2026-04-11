"""
Bluetooth Low Energy scanner.

Extends BaseScanner with BLE-specific logic:
- Async scanning via bleak (BleakScanner callback model)
- Manufacturer data parsing and service profile identification
- ORM persistence to bluetooth_devices / bluetooth_history tables
"""

import asyncio
import time

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData
from sqlalchemy import delete, select

from app.core.scanner import BaseScanner
from app.core.store import MAX_HISTORY
from app.models.base import db
from app.models.bluetooth import BluetoothDevice, BluetoothHistory

from .metadata import address_type, device_profiles, manufacturer_info, path_loss

# Fallback reference RSSI at 1 m when device doesn't advertise TX power (dBm).
_DEFAULT_TX_POWER = -59

# Speed thresholds for movement classification (m/s).
_SPEED_STATIONARY = 0.03
_SPEED_FAST = 0.15


class BluetoothScanner(BaseScanner):
    """BLE scanner: bleak-based discovery + ORM persistence."""

    def __init__(self) -> None:
        super().__init__(speed_stationary=_SPEED_STATIONARY, speed_fast=_SPEED_FAST)

    # ── BaseScanner interface ─────────────────────────────────────────────────

    def _ref_rssi(self, snapshot: dict) -> float:
        return snapshot.get("tx_power") or _DEFAULT_TX_POWER

    def _do_scan(
        self, timeout: float, n: float
    ) -> tuple[list[tuple], set[str], float]:
        readings: list[tuple] = []
        active: set[str] = set()

        def callback(device: BLEDevice, adv: AdvertisementData) -> None:
            if device.address in active:
                return  # de-duplicate within one scan window

            ts = time.time()
            mfr = manufacturer_info(adv.manufacturer_data)
            profiles = device_profiles(adv.service_uuids)
            ref = adv.tx_power or _DEFAULT_TX_POWER
            # Distance at callback time uses the raw RSSI — smoothing happens in _build_results.
            dist = 10 ** ((ref - adv.rssi) / (10 * n)) if adv.rssi < 0 else None
            if dist is not None:
                dist = round(dist, 2)

            snapshot = {
                "address":           device.address,
                "name":              device.name or adv.local_name or "Unknown",
                "rssi":              adv.rssi,
                "tx_power":          adv.tx_power,
                "address_type":      address_type(device.address),
                "is_apple":          mfr["is_apple"],
                "is_microsoft":      mfr["is_microsoft"],
                "known_companies":   mfr["known_companies"],
                "device_profiles":   profiles,
                "path_loss_db":      path_loss(adv.rssi, adv.tx_power),
                "service_uuids":     list(adv.service_uuids),
                "manufacturer_data": {f"0x{k:04X}": v.hex() for k, v in adv.manufacturer_data.items()},
                "service_data":      {str(k): v.hex() for k, v in adv.service_data.items()},
            }

            active.add(device.address)
            readings.append((device.address, snapshot, adv.rssi, dist, ts))

        asyncio.run(self._async_scan(timeout, callback))
        return readings, active, time.time()

    def _init_store(self) -> None:
        """Load all persisted BLE devices and their history into the in-memory store."""
        try:
            devices = db.session.execute(db.select(BluetoothDevice)).scalars().all()
            for dev in devices:
                rows = (
                    db.session.execute(
                        db.select(BluetoothHistory)
                        .where(BluetoothHistory.address == dev.address)
                        .order_by(BluetoothHistory.recorded_at.asc())
                        .limit(MAX_HISTORY)
                    )
                    .scalars().all()
                )
                self._store.seed(
                    key=dev.address,
                    snapshot={
                        "address":           dev.address,
                        "name":              dev.name,
                        "rssi":              rows[-1].rssi if rows else -100,
                        "tx_power":          dev.tx_power,
                        "address_type":      dev.address_type,
                        "is_apple":          dev.is_apple,
                        "is_microsoft":      dev.is_microsoft,
                        "known_companies":   dev.known_companies or [],
                        "device_profiles":   dev.device_profiles or [],
                        "path_loss_db":      None,
                        "service_uuids":     dev.service_uuids or [],
                        "manufacturer_data": dev.manufacturer_data or {},
                        "service_data":      dev.service_data or {},
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
        """Upsert the BLE device row and insert one history entry (no commit)."""
        try:
            existing = db.session.get(BluetoothDevice, key)
            if existing is None:
                db.session.add(BluetoothDevice(
                    address=key,
                    name=snapshot["name"],
                    tx_power=snapshot.get("tx_power"),
                    address_type=snapshot["address_type"],
                    is_apple=snapshot["is_apple"],
                    is_microsoft=snapshot["is_microsoft"],
                    known_companies=snapshot["known_companies"],
                    device_profiles=snapshot["device_profiles"],
                    service_uuids=snapshot["service_uuids"],
                    manufacturer_data=snapshot["manufacturer_data"],
                    service_data=snapshot["service_data"],
                    last_seen_at=ts,
                    created_at=ts,
                ))
            else:
                existing.name = snapshot["name"]
                existing.tx_power = snapshot.get("tx_power")
                existing.address_type = snapshot["address_type"]
                existing.is_apple = snapshot["is_apple"]
                existing.is_microsoft = snapshot["is_microsoft"]
                existing.known_companies = snapshot["known_companies"]
                existing.device_profiles = snapshot["device_profiles"]
                existing.service_uuids = snapshot["service_uuids"]
                existing.manufacturer_data = snapshot["manufacturer_data"]
                existing.service_data = snapshot["service_data"]
                existing.last_seen_at = ts

            history_row = BluetoothHistory(address=key, rssi=rssi, distance=distance, recorded_at=ts)
            db.session.add(history_row)
            db.session.flush()  # assign ID before trim query

            self._trim_history(key)
        except Exception:
            pass  # non-fatal; in-memory store is authoritative

    def _clear_db(self) -> None:
        """Delete all BLE records and commit."""
        try:
            db.session.execute(delete(BluetoothHistory))
            db.session.execute(delete(BluetoothDevice))
            db.session.commit()
        except Exception:
            db.session.rollback()

    # ── Internal helpers ──────────────────────────────────────────────────────

    @staticmethod
    async def _async_scan(timeout: float, callback) -> None:
        async with BleakScanner(callback):
            await asyncio.sleep(timeout)

    @staticmethod
    def _trim_history(address: str) -> None:
        """Keep only the most recent MAX_HISTORY rows for this address."""
        keep_ids = (
            select(BluetoothHistory.id)
            .where(BluetoothHistory.address == address)
            .order_by(BluetoothHistory.recorded_at.desc())
            .limit(MAX_HISTORY)
            .subquery()
        )
        db.session.execute(
            delete(BluetoothHistory)
            .where(BluetoothHistory.address == address)
            .where(BluetoothHistory.id.notin_(select(keep_ids.c.id)))
            .execution_options(synchronize_session="fetch")
        )
