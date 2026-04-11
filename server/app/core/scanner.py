"""
Abstract base scanner.

Defines the common scan flow shared by all protocol scanners:
    1. Lazy store initialisation from DB (_init_store)
    2. Protocol-specific scan (_do_scan) — returns raw readings + active keys
    3. In-memory store update
    4. ORM persistence per reading (_persist_reading)
    5. Single DB commit
    6. Response assembly (_build_results)

Subclasses implement the four abstract methods; everything else is shared.
"""

import time
from abc import ABC, abstractmethod

from .distance import DistanceEstimator
from .movement import MovementClassifier
from .store import DeviceStore

SMOOTH_WINDOW = 5  # RSSI readings averaged for smoothed output


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
            readings   — list of (key, snapshot, rssi, distance, timestamp)
            active_keys — set of device keys seen in this scan window
            scan_time  — canonical timestamp for the completed scan
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
        ts: float,
    ) -> None:
        """Upsert the device record and append one history row (no commit)."""

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
                self._store.update(key, snapshot, ts, rssi, distance)
                self._persist_reading(key, snapshot, rssi, distance, ts)
            db.session.commit()
        except Exception:
            db.session.rollback()

        return self._build_results(active_keys, scan_time, environment)

    def reset(self) -> None:
        """Clear all in-memory and persisted device state."""
        self._store.clear()
        self._store.initialized = True  # skip reload — store is intentionally empty
        self._clear_db()

    # ── Result assembly ───────────────────────────────────────────────────────

    def _build_results(
        self, active_keys: set[str], scan_time: float, environment: str
    ) -> list[dict]:
        """Assemble the full API response from the current store state."""
        n = self._estimator.get_n(environment)
        result = []

        for key, entry in self._store.entries():
            hist = entry["history"]
            if not hist:
                continue

            # Smooth RSSI over the last SMOOTH_WINDOW readings
            window = [h["rssi"] for h in hist[-SMOOTH_WINDOW:]]
            smooth_rssi = round(sum(window) / len(window)) if window else -100

            dist_smooth = self._estimator.estimate(smooth_rssi, self._ref_rssi(entry["snapshot"]), environment)
            quality = self._estimator.signal_quality(smooth_rssi)

            speeds = self._classifier.compute_speeds(hist)
            status = self._classifier.classify(speeds, self._speed_stationary, self._speed_fast)

            latest = hist[-1]["time"]
            history_rel = [
                {"t": round(h["time"] - latest, 1), "rssi": h["rssi"], "distance": h["distance"]}
                for h in hist
            ]

            result.append({
                **entry["snapshot"],
                "rssi":                 smooth_rssi,
                "signal_quality_pct":   quality,
                "estimated_distance_m": dist_smooth,
                "active":               key in active_keys,
                "last_seen_s":          round(scan_time - entry["last_seen"], 1),
                "history":              history_rel,
                "movement_label":       status["label"],
                "movement_cls":         status["cls"],
            })

        return result
