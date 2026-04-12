"""
Abstract base scanner.

Defines the common scan flow shared by all protocol scanners:
    1. Lazy store initialisation from DB (_init_store)
    2. Protocol-specific scan (_do_scan) — returns raw readings + active keys
    3. EWMA RSSI smoothing per reading (_compute_ewma_rssi)
    4. In-memory store update (raw + smoothed values)
    5. ORM persistence per reading (_persist_reading)
    6. Single DB commit for scan data
    7. Response assembly (_build_results) — uses smoothed values, updates
       movement state in store via hysteresis classifier
    8. Movement state persistence commit (_persist_movement_state)

Subclasses implement the five abstract methods; everything else is shared.
"""

import math
import time
from abc import ABC, abstractmethod

from .distance import DistanceEstimator
from .movement import MovementClassifier
from .store import DeviceStore

# EWMA smoothing constants
EWMA_ALPHA     = 0.3   # weight for the newest RSSI reading
OUTLIER_WINDOW = 10    # history rows used for outlier mean/std
OUTLIER_SIGMA  = 2.0   # rejection threshold (standard deviations)


class BaseScanner(ABC):
    """Protocol-agnostic scanner base class (Open/Closed, Liskov-substitutable)."""

    def __init__(self, speed_stationary: float, speed_fast: float) -> None:
        self._store = DeviceStore()
        self._estimator = DistanceEstimator()
        self._classifier = MovementClassifier()
        self._speed_stationary = speed_stationary
        self._speed_fast = speed_fast

    # ── Abstract interface ────────────────────────────────────────────────────

    @abstractmethod
    def _do_scan(
        self, timeout: float, n: float
    ) -> tuple[list[tuple[str, dict, float, float | None, float]], set[str], float]:
        """
        Run the protocol-specific scan.

        Returns:
            readings    — list of (key, snapshot, rssi, distance, timestamp)
            active_keys — set of device keys seen in this scan window
            scan_time   — canonical timestamp for the completed scan
        """

    @abstractmethod
    def _ref_rssi(self, snapshot: dict) -> float:
        """Reference RSSI (dBm) used as the 1-metre baseline for distance estimation."""

    @abstractmethod
    def _init_store(self) -> None:
        """Populate self._store from persisted DB records (called once, lazily)."""

    @abstractmethod
    def _persist_reading(
        self,
        key: str,
        snapshot: dict,
        rssi: float,
        distance: float | None,
        smoothed_rssi: float | None,
        is_outlier: bool,
        ts: float,
    ) -> None:
        """Upsert the device record and append one history row (no commit)."""

    @abstractmethod
    def _persist_movement_state(
        self,
        key: str,
        smoothed_speed: float | None,
        movement_state: str | None,
        movement_since: float | None,
    ) -> None:
        """Update the device row's movement columns (no commit)."""

    @abstractmethod
    def _clear_db(self) -> None:
        """Delete all records from the protocol's DB tables and commit."""

    # ── Common scan flow ──────────────────────────────────────────────────────

    def get_devices(self, timeout: float = 5.0, environment: str = "indoor_mixed") -> list[dict]:
        """Scan, persist, and return all known devices (active + stale)."""
        if not self._store.initialized:
            self._init_store()
            self._store.initialized = True

        n = self._estimator.get_n(environment)
        readings, active_keys, scan_time = self._do_scan(timeout, n)

        from app.models.base import db
        try:
            for key, snapshot, rssi, distance, ts in readings:
                hist      = self._store.get_history(key)
                prev_ewma = self._store.get_smoothed_rssi(key)
                smoothed_rssi, is_outlier = self._compute_ewma_rssi(rssi, hist, prev_ewma)
                smoothed_dist = self._estimator.estimate(
                    smoothed_rssi, self._ref_rssi(snapshot), environment
                )
                self._store.update(
                    key, snapshot, ts,
                    rssi, distance,
                    smoothed_rssi, smoothed_dist, is_outlier,
                )
                self._persist_reading(
                    key, snapshot, rssi, distance, smoothed_rssi, is_outlier, ts
                )
            db.session.commit()
        except Exception:
            db.session.rollback()

        results = self._build_results(active_keys, scan_time, environment)

        # Persist updated movement state for all known devices.
        try:
            for key, entry in self._store.entries():
                self._persist_movement_state(
                    key,
                    entry.get("smoothed_speed"),
                    entry.get("movement_state"),
                    entry.get("movement_since"),
                )
            db.session.commit()
        except Exception:
            db.session.rollback()

        return results

    def reset(self) -> None:
        """Clear all in-memory and persisted device state."""
        self._store.clear()
        self._store.initialized = True  # skip reload — store is intentionally empty
        self._clear_db()

    # ── EWMA smoothing ────────────────────────────────────────────────────────

    @staticmethod
    def _compute_ewma_rssi(
        raw_rssi: float,
        hist_rows: list[dict],
        prev_ewma: float | None,
    ) -> tuple[float, bool]:
        """Compute EWMA-smoothed RSSI with outlier gating.

        Returns (smoothed_rssi, is_outlier).  When an outlier is detected the
        previous EWMA is returned unchanged so one bad reading cannot corrupt
        the running estimate.
        """
        recent = [h["rssi"] for h in hist_rows[-OUTLIER_WINDOW:]]
        if len(recent) >= 4:
            mean = sum(recent) / len(recent)
            variance = sum((x - mean) ** 2 for x in recent) / len(recent)
            std = math.sqrt(variance)
            if std > 0 and abs(raw_rssi - mean) > OUTLIER_SIGMA * std:
                # Outlier: keep previous EWMA (bootstrap from raw if no prior).
                return (prev_ewma if prev_ewma is not None else float(raw_rssi)), True

        if prev_ewma is None:
            return float(raw_rssi), False  # first reading — bootstrap
        return EWMA_ALPHA * raw_rssi + (1 - EWMA_ALPHA) * prev_ewma, False

    # ── Result assembly ───────────────────────────────────────────────────────

    def _build_results(
        self, active_keys: set[str], scan_time: float, environment: str
    ) -> list[dict]:
        """Assemble the full API response from the current store state."""
        result = []

        for key, entry in self._store.entries():
            hist = entry["history"]
            if not hist:
                continue

            latest = hist[-1]

            # Use the pre-computed smoothed RSSI; fall back to raw for old/seeded rows.
            smooth_rssi = latest.get("smoothed_rssi")
            if smooth_rssi is None:
                smooth_rssi = float(latest["rssi"])
            smooth_rssi_int = round(smooth_rssi)

            # Use the pre-computed smoothed distance; recompute only if absent.
            dist_smooth = latest.get("smoothed_distance")
            if dist_smooth is None:
                dist_smooth = self._estimator.estimate(
                    smooth_rssi, self._ref_rssi(entry["snapshot"]), environment
                )

            quality = self._estimator.signal_quality(smooth_rssi)

            # Build history list using smoothed distances for movement calculation
            # (falls back to raw distance for seeded rows that predate this feature).
            hist_for_movement = [
                {
                    "time":     h["time"],
                    "distance": h["smoothed_distance"]
                                if h.get("smoothed_distance") is not None
                                else h["distance"],
                }
                for h in hist
            ]
            speeds = self._classifier.compute_speeds(hist_for_movement)
            status = self._classifier.classify(
                speeds,
                self._speed_stationary,
                self._speed_fast,
                prev_smoothed_speed=entry.get("smoothed_speed"),
                prev_state=entry.get("movement_state"),
                prev_since=entry.get("movement_since"),
                now=scan_time,
            )

            # Write movement state back to the store so _persist_movement_state
            # can flush it to the DB in the second commit.
            entry["smoothed_speed"]  = status["smoothed_speed"]
            entry["movement_state"]  = status["state"]
            entry["movement_since"]  = status["since"]

            latest_ts = hist[-1]["time"]
            history_rel = [
                {"t": round(h["time"] - latest_ts, 1), "rssi": h["rssi"], "distance": h["distance"]}
                for h in hist
            ]

            result.append({
                **entry["snapshot"],
                "rssi":                 smooth_rssi_int,
                "signal_quality_pct":   quality,
                "estimated_distance_m": dist_smooth,
                "active":               key in active_keys,
                "last_seen_s":          round(scan_time - entry["last_seen"], 1),
                "history":              history_rel,
                "movement_label":       status["label"],
                "movement_cls":         status["cls"],
            })

        return result
