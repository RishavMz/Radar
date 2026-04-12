"""
Protocol-agnostic in-memory device store.

Holds snapshots and RSSI/distance history for all known devices. Both
BluetoothScanner and WifiScanner own one instance each.  The store is
populated lazily from the database on the first scan, then kept in sync
on every reading.
"""

MAX_HISTORY = 60


class DeviceStore:
    """
    Key-indexed in-memory cache of device state.

    Each entry holds:
        snapshot         — latest metadata dict for the device
        history          — list of dicts (oldest first):
                               time, rssi, distance,
                               smoothed_rssi, smoothed_distance, is_outlier
        last_seen        — Unix timestamp of the most recent reading
        smoothed_speed   — last EWMA speed value (m/s); None until 2+ readings
        movement_state   — last confirmed state string; None until classified
        movement_since   — Unix timestamp of last state transition
    """

    def __init__(self) -> None:
        self._data: dict[str, dict] = {}
        self.initialized: bool = False

    # ── Mutation ───────────────────────────────────────────────────────────────

    def update(
        self,
        key: str,
        snapshot: dict,
        ts: float,
        rssi: float,
        distance: float | None,
        smoothed_rssi: float | None = None,
        smoothed_distance: float | None = None,
        is_outlier: bool = False,
    ) -> None:
        """Record a new reading for *key*."""
        if key not in self._data:
            self._data[key] = {
                "snapshot": {},
                "history": [],
                "last_seen": 0.0,
                "smoothed_speed": None,
                "movement_state": None,
                "movement_since": None,
            }
        entry = self._data[key]
        entry["snapshot"] = snapshot
        entry["last_seen"] = ts
        hist = entry["history"]
        hist.append({
            "time":             ts,
            "rssi":             rssi,
            "distance":         distance,
            "smoothed_rssi":    smoothed_rssi,
            "smoothed_distance": smoothed_distance,
            "is_outlier":       is_outlier,
        })
        if len(hist) > MAX_HISTORY:
            hist.pop(0)

    def seed(
        self,
        key: str,
        snapshot: dict,
        history: list[dict],
        last_seen: float,
        smoothed_speed: float | None = None,
        movement_state: str | None = None,
        movement_since: float | None = None,
    ) -> None:
        """Populate a store entry from persisted DB data (used during _init_store)."""
        self._data[key] = {
            "snapshot":       snapshot,
            "history":        history,
            "last_seen":      last_seen,
            "smoothed_speed": smoothed_speed,
            "movement_state": movement_state,
            "movement_since": movement_since,
        }

    def clear(self) -> None:
        self._data.clear()

    # ── Query ──────────────────────────────────────────────────────────────────

    def entries(self):
        return self._data.items()

    def get_history(self, key: str) -> list[dict]:
        """Return the history list for *key*, or [] if not present."""
        return self._data.get(key, {}).get("history", [])

    def get_smoothed_rssi(self, key: str) -> float | None:
        """Return the most recent smoothed_rssi for *key*, or None if unavailable."""
        for entry in reversed(self._data.get(key, {}).get("history", [])):
            val = entry.get("smoothed_rssi")
            if val is not None:
                return val
        return None

    def __len__(self) -> int:
        return len(self._data)
