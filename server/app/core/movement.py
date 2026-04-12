"""
Movement classification from device distance history.

Computes per-interval speed (m/s) between consecutive readings and classifies
the recent trend as stationary, approaching, or moving away.

Improvements over the naive approach:
- Speed EWMA (beta=0.4) damps single-sample noise before thresholding.
- Hysteresis: a state change is only accepted when the candidate state appears
  in >= HYSTERESIS_CONFIRM of the last STATUS_WINDOW speed samples, preventing
  rapid flickering at threshold boundaries.
- State and EWMA seed are persisted across scans via the caller (scanner layer).
"""

import time
from collections import Counter

SPEED_EWMA_BETA    = 0.4  # weight for the newest speed sample
HYSTERESIS_CONFIRM = 3    # confirmations required out of STATUS_WINDOW


class MovementClassifier:
    """Stateless helper for speed derivation and movement classification."""

    STATUS_WINDOW = 4  # number of recent speed samples considered

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
        prev_smoothed_speed: float | None = None,
        prev_state: str | None = None,
        prev_since: float | None = None,
        now: float | None = None,
    ) -> dict:
        """Classify recent movement as stable / closer / away / tracking.

        Returns a dict with keys:
            label           — human-readable string
            cls             — 'stable' | 'closer' | 'away' | 'tracking'
            smoothed_speed  — updated EWMA speed (m/s); caller should persist this
            state           — raw state string; caller should persist this
            since           — Unix timestamp of last state transition
        """
        _now = now or time.time()
        valid = [s for s in speeds if s is not None]

        if not valid:
            return {
                "label":          "Tracking\u2026",
                "cls":            "tracking",
                "smoothed_speed": prev_smoothed_speed,
                "state":          "tracking",
                "since":          prev_since or _now,
            }

        # Speed EWMA — weight latest sample more than the historical average.
        latest_speed = valid[-1]
        if prev_smoothed_speed is None:
            new_smooth = latest_speed
        else:
            new_smooth = SPEED_EWMA_BETA * latest_speed + (1 - SPEED_EWMA_BETA) * prev_smoothed_speed

        # Classify each of the last STATUS_WINDOW valid samples.
        recent = valid[-self.STATUS_WINDOW:]
        sample_states = []
        for s in recent:
            if abs(s) < speed_stationary:
                sample_states.append("stable")
            elif s < 0:
                sample_states.append("closer")
            else:
                sample_states.append("away")

        # Hysteresis: only accept a state change when it is confirmed enough times.
        dominant_state, dominant_count = Counter(sample_states).most_common(1)[0]

        if dominant_count >= HYSTERESIS_CONFIRM or prev_state is None:
            new_state = dominant_state
            new_since = prev_since if new_state == prev_state else _now
        else:
            # Hold the previous state — not enough confirmation yet.
            new_state = prev_state
            new_since = prev_since or _now

        # Build the human-readable label from confirmed state + smoothed speed.
        avg = new_smooth
        if new_state == "stable":
            label, cls = "Stationary", "stable"
        elif new_state == "closer":
            label = "Approaching fast" if abs(avg) > speed_fast else "Getting closer"
            cls   = "closer"
        else:  # away
            label = "Moving away fast" if abs(avg) > speed_fast else "Moving away"
            cls   = "away"

        return {
            "label":          label,
            "cls":            cls,
            "smoothed_speed": new_smooth,
            "state":          new_state,
            "since":          new_since,
        }
