"""
Distance estimation and signal quality helpers.

Uses the log-distance path-loss model:
    distance = 10 ^ ((ref_rssi - rssi) / (10 * n))

where n is the path-loss exponent controlled by the environment profile.
"""


class DistanceEstimator:
    """Stateless helper for RSSI-to-distance conversion and signal quality scoring."""

    ENVIRONMENTS: dict[str, float] = {
        "outdoor":      2.0,
        "indoor_open":  2.5,
        "indoor_mixed": 3.0,
        "indoor_dense": 3.5,
    }
    DEFAULT_ENVIRONMENT = "indoor_mixed"

    def get_n(self, environment: str) -> float:
        """Return the path-loss exponent for the given environment profile."""
        return self.ENVIRONMENTS.get(environment, self.ENVIRONMENTS[self.DEFAULT_ENVIRONMENT])

    def estimate(self, rssi: float, ref_rssi: float, environment: str) -> float | None:
        """Compute estimated distance in metres.

        Returns None for non-negative RSSI values (clearly invalid readings).
        """
        if rssi >= 0:
            return None
        n = self.get_n(environment)
        return round(10 ** ((ref_rssi - rssi) / (10 * n)), 2)

    def signal_quality(self, rssi: float) -> int:
        """Map RSSI to a 0–100% quality score (-100 dBm → 0%, -30 dBm → 100%)."""
        clamped = max(-100.0, min(-30.0, rssi))
        return round((clamped + 100) / 70 * 100)
