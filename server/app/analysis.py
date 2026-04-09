"""
Device motion analysis: Kalman-filtered RSSI → smoothed distance, speed, trend.
"""

import os

_DEFAULT_TX_POWER = int(os.getenv("BLE_DEFAULT_TX_POWER", -59))
_PATH_LOSS_N = float(os.getenv("BLE_PATH_LOSS_N", 2.0))

# Kalman filter tuning
_Q = 2.0   # Process noise (dBm²): expected RSSI drift between scans
_R = 9.0   # Measurement noise (dBm²): ±3 dBm sensor uncertainty

# Trend threshold: slope in m/s below which device is considered stationary
_TREND_THRESHOLD = 0.05


def analyse_device(records: list) -> dict:
    """
    Analyse a time-ordered list of BLEDevice ORM objects for one address.
    Returns smoothed distance, speed, and movement trend.
    """
    n = len(records)
    if n == 0:
        return {}

    rssi_values = [r.rssi for r in records]
    timestamps = [r.scanned_at.timestamp() for r in records]
    tx_power = next((r.tx_power for r in records if r.tx_power is not None), None)

    smoothed_rssi = _kalman_filter(rssi_values)
    distances = [_distance(rssi, tx_power) for rssi in smoothed_rssi]

    # Speed: median of |Δd/Δt| across consecutive pairs — median rejects outlier jumps
    speeds = []
    for i in range(1, len(distances)):
        dt = timestamps[i] - timestamps[i - 1]
        if dt > 0:
            speeds.append(abs(distances[i] - distances[i - 1]) / dt)
    speed = _median(speeds) if speeds else None

    # Trend: linear regression slope of smoothed distances over time
    slope = _linear_slope(timestamps, distances)
    if slope > _TREND_THRESHOLD:
        trend = "receding"
    elif slope < -_TREND_THRESHOLD:
        trend = "approaching"
    else:
        trend = "stationary"

    return {
        "smoothed_distance_m": round(distances[-1], 2),
        "speed_m_s": round(speed, 3) if speed is not None else None,
        "trend": trend,
        "datapoints": [
            {
                "timestamp": records[i].scanned_at.isoformat(),
                "rssi": records[i].rssi,
                "raw_distance_m": round(records[i].estimated_distance_m, 2)
                if records[i].estimated_distance_m is not None
                else None,
                "smoothed_distance_m": round(distances[i], 2),
            }
            for i in range(n)
        ],
    }


# --- Internal helpers ---

def _kalman_filter(measurements: list[float]) -> list[float]:
    """
    1D Kalman filter.
    State = true RSSI; no control input; constant process model.
    """
    if not measurements:
        return []
    x = float(measurements[0])
    p = _R  # start uncertainty equal to measurement noise
    result = [x]
    for z in measurements[1:]:
        # Predict
        p_pred = p + _Q
        # Update
        k = p_pred / (p_pred + _R)          # Kalman gain
        x = x + k * (z - x)
        p = (1.0 - k) * p_pred
        result.append(x)
    return result


def _distance(rssi: float, tx_power: int | None) -> float:
    ref = tx_power if tx_power is not None else _DEFAULT_TX_POWER
    return 10 ** ((ref - rssi) / (10 * _PATH_LOSS_N))


def _median(values: list[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def _linear_slope(xs: list[float], ys: list[float]) -> float:
    """Least-squares slope of ys over xs (m/s when xs=timestamps, ys=distances)."""
    n = len(xs)
    if n < 2:
        return 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs)
    return num / den if den else 0.0
