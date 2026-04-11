"""
Movement classification from device distance history.

Computes per-interval speed (m/s) between consecutive readings and classifies
the recent trend as stationary, approaching, or moving away.
"""


class MovementClassifier:
    """Stateless helper for speed derivation and movement classification."""

    STATUS_WINDOW = 4  # number of recent speed samples to average

    def compute_speeds(self, history: list[dict]) -> list[float | None]:
        """Derive per-interval speed (m/s) from consecutive distance readings."""
        speeds: list[float | None] = []
        for i in range(1, len(history)):
            prev, curr = history[i - 1], history[i]
            if prev["distance"] is None or curr["distance"] is None:
                speeds.append(None)
                continue
            dt = curr["time"] - prev["time"]
            speeds.append((curr["distance"] - prev["distance"]) / dt if dt > 0 else None)
        return speeds

    def classify(
        self,
        speeds: list[float | None],
        speed_stationary: float,
        speed_fast: float,
    ) -> dict:
        """Classify recent movement as stable / closer / away / tracking."""
        valid = [s for s in speeds if s is not None]
        if not valid:
            return {"label": "Tracking\u2026", "cls": "tracking"}

        avg = sum(valid[-self.STATUS_WINDOW:]) / min(len(valid), self.STATUS_WINDOW)

        if abs(avg) < speed_stationary:
            return {"label": "Stationary",      "cls": "stable"}
        if avg < -speed_fast:
            return {"label": "Approaching fast", "cls": "closer"}
        if avg < 0:
            return {"label": "Getting closer",   "cls": "closer"}
        if avg > speed_fast:
            return {"label": "Moving away fast", "cls": "away"}
        return {"label": "Moving away",          "cls": "away"}
