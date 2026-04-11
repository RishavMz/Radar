"""
Protocol-agnostic in-memory device store.

Holds snapshots and RSSI/distance history for all known devices. Both
BluetoothScanner and WifiScanner own one instance each.  The store is
populated lazily from the database on the first scan, then kept in sync
on every reading.
"""

MAX_HISTORY = 30


class DeviceStore:
    """
    Key-indexed in-memory cache of device state.

    Each entry holds:
        snapshot   — latest metadata dict for the device
        history    — list of {"time", "rssi", "distance"} dicts, oldest first
        last_seen  — Unix timestamp of the most recent reading
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
    ) -> None:
        """Record a new reading for *key*."""
        if key not in self._data:
            self._data[key] = {"snapshot": {}, "history": [], "last_seen": 0.0}
        entry = self._data[key]
        entry["snapshot"] = snapshot
        entry["last_seen"] = ts
        hist = entry["history"]
        hist.append({"time": ts, "rssi": rssi, "distance": distance})
        if len(hist) > MAX_HISTORY:
            hist.pop(0)

    def seed(self, key: str, snapshot: dict, history: list[dict], last_seen: float) -> None:
        """Populate a store entry from persisted DB data (used during _init_store)."""
        self._data[key] = {
            "snapshot": snapshot,
            "history": history,
            "last_seen": last_seen,
        }

    def clear(self) -> None:
        self._data.clear()

    # ── Query ──────────────────────────────────────────────────────────────────

    def entries(self):
        return self._data.items()

    def __len__(self) -> int:
        return len(self._data)
