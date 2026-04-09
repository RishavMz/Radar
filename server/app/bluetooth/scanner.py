import asyncio
import time
from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

# ── Constants ─────────────────────────────────────────────────────────────────

# Assumed TX power at 1 metre when device doesn't advertise one (dBm)
_DEFAULT_TX_POWER = -59

# Per-device history
_MAX_HISTORY      = 30  # data points retained per device
_STATUS_WINDOW    = 4   # most-recent speed samples used for status classification
_RSSI_SMOOTH_WIN  = 5   # readings averaged for smoothed RSSI / distance

# Speed thresholds (m/s); positive = moving away, negative = getting closer
_SPEED_STATIONARY = 0.03
_SPEED_FAST       = 0.15

# Environment profiles: path-loss exponent n for log-distance model.
# Higher n = signal falls off faster = larger distance estimates (realistic indoors).
_ENVIRONMENTS: dict[str, dict] = {
    "outdoor":      {"n": 2.0, "label": "Outdoor"},
    "indoor_open":  {"n": 2.5, "label": "Indoor \u2013 Open"},
    "indoor_mixed": {"n": 3.0, "label": "Indoor \u2013 Mixed"},
    "indoor_dense": {"n": 3.5, "label": "Indoor \u2013 Dense"},
}
_DEFAULT_ENVIRONMENT = "indoor_mixed"

_COMPANY_IDS = {
    0x004C: "Apple",
    0x0006: "Microsoft",
    0x0075: "Samsung",
    0x00E0: "Google",
    0x0157: "Garmin",
    0x01D5: "Fitbit",
}

_SERVICE_PROFILES = {
    "0000180d-0000-1000-8000-00805f9b34fb": "Heart Rate",
    "0000180f-0000-1000-8000-00805f9b34fb": "Battery",
    "00001812-0000-1000-8000-00805f9b34fb": "HID",
    "0000110b-0000-1000-8000-00805f9b34fb": "Audio Sink",
    "0000110a-0000-1000-8000-00805f9b34fb": "Audio Source",
    "00001800-0000-1000-8000-00805f9b34fb": "Generic Access",
    "00001801-0000-1000-8000-00805f9b34fb": "Generic Attribute",
    "00001804-0000-1000-8000-00805f9b34fb": "TX Power",
    "00001805-0000-1000-8000-00805f9b34fb": "Current Time",
    "00001816-0000-1000-8000-00805f9b34fb": "Cycling Speed and Cadence",
    "00001818-0000-1000-8000-00805f9b34fb": "Cycling Power",
    "00001819-0000-1000-8000-00805f9b34fb": "Location and Navigation",
    "0000181c-0000-1000-8000-00805f9b34fb": "User Data",
    "0000181d-0000-1000-8000-00805f9b34fb": "Weight Scale",
    "0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
    "00001802-0000-1000-8000-00805f9b34fb": "Immediate Alert",
    "00001803-0000-1000-8000-00805f9b34fb": "Link Loss",
    "00001111-0000-1000-8000-00805f9b34fb": "Audio/Video Remote Control",
}

# ── Device store ──────────────────────────────────────────────────────────────

# Persists across scans. Stale devices are retained and returned with active=False.
# address -> {
#   "snapshot":  dict,         last known device fields
#   "history":   list[dict],   [{time, rssi, distance_raw}, ...]
#   "last_seen": float,        unix timestamp
# }
_device_store: dict[str, dict] = {}


# ── Signal / metadata helpers ─────────────────────────────────────────────────

def _estimate_distance(rssi: int, tx_power: int | None, n: float) -> float | None:
    """Log-distance path-loss model. n=2.0 free space, higher indoors."""
    if rssi >= 0:
        return None
    ref = tx_power if tx_power is not None else _DEFAULT_TX_POWER
    return round(10 ** ((ref - rssi) / (10 * n)), 2)


def _signal_quality(rssi: int) -> int:
    clamped = max(-100, min(-30, rssi))
    return round((clamped + 100) / 70 * 100)


def _path_loss(rssi: int, tx_power: int | None) -> int | None:
    return (tx_power - rssi) if tx_power is not None else None


def _address_type(address: str) -> str:
    first_byte = int(address.split(":")[0], 16)
    return "random" if first_byte >= 0xC0 else "public"


def _manufacturer_info(manufacturer_data: dict[int, bytes]) -> dict:
    companies = [name for cid, name in _COMPANY_IDS.items() if cid in manufacturer_data]
    return {
        "is_apple":        0x004C in manufacturer_data,
        "is_microsoft":    0x0006 in manufacturer_data,
        "known_companies": companies,
    }


def _device_profiles(service_uuids: list[str]) -> list[str]:
    return [
        profile
        for uuid in service_uuids
        if (profile := _SERVICE_PROFILES.get(uuid.lower()))
    ]


def _smooth_rssi(history: list[dict]) -> int:
    """Average of the last _RSSI_SMOOTH_WIN raw RSSI readings."""
    recent = [h["rssi"] for h in history[-_RSSI_SMOOTH_WIN:]]
    return round(sum(recent) / len(recent))


# ── Store management ──────────────────────────────────────────────────────────

def _update_store(address: str, snapshot: dict, ts: float, rssi: int, distance_raw: float | None) -> list[dict]:
    if address not in _device_store:
        _device_store[address] = {"snapshot": {}, "history": [], "last_seen": 0.0}
    entry = _device_store[address]
    entry["snapshot"]  = snapshot
    entry["last_seen"] = ts
    hist = entry["history"]
    hist.append({"time": ts, "rssi": rssi, "distance": distance_raw})
    if len(hist) > _MAX_HISTORY:
        hist.pop(0)
    return hist


def _compute_speeds(history: list[dict]) -> list[float | None]:
    speeds: list[float | None] = []
    for i in range(1, len(history)):
        prev, curr = history[i - 1], history[i]
        if prev["distance"] is None or curr["distance"] is None:
            speeds.append(None)
            continue
        dt = curr["time"] - prev["time"]
        speeds.append((curr["distance"] - prev["distance"]) / dt if dt > 0 else None)
    return speeds


def _movement_status(speeds: list[float | None]) -> dict:
    valid = [s for s in speeds if s is not None]
    if not valid:
        return {"label": "Tracking\u2026", "cls": "tracking"}

    avg = sum(valid[-_STATUS_WINDOW:]) / min(len(valid), _STATUS_WINDOW)

    if abs(avg) < _SPEED_STATIONARY: return {"label": "Stationary",      "cls": "stable"}
    if avg < -_SPEED_FAST:           return {"label": "Approaching fast", "cls": "closer"}
    if avg < 0:                      return {"label": "Getting closer",   "cls": "closer"}
    if avg > _SPEED_FAST:            return {"label": "Moving away fast", "cls": "away"}
    return                                  {"label": "Moving away",      "cls": "away"}


# ── Public API ────────────────────────────────────────────────────────────────

def get_bluetooth_devices(timeout: float = 5.0, environment: str = _DEFAULT_ENVIRONMENT) -> list[dict]:
    """Scan for nearby BLE devices and return all known devices (active + stale)."""
    env = _ENVIRONMENTS.get(environment, _ENVIRONMENTS[_DEFAULT_ENVIRONMENT])
    return asyncio.run(_scan(timeout, env))


async def _scan(timeout: float, env: dict) -> list[dict]:
    active_addresses: set[str] = set()
    n = env["n"]

    def callback(device: BLEDevice, adv: AdvertisementData):
        if device.address in active_addresses:
            return

        ts       = time.time()
        mfr_info = _manufacturer_info(adv.manufacturer_data)
        profiles = _device_profiles(adv.service_uuids)

        # Raw distance uses the current scan's RSSI (single reading, pre-smoothing)
        distance_raw = _estimate_distance(adv.rssi, adv.tx_power, n)

        snapshot = {
            "address":              device.address,
            "name":                 device.name or adv.local_name or "Unknown",
            "rssi":                 adv.rssi,
            "tx_power":             adv.tx_power,
            "address_type":         _address_type(device.address),
            "is_apple":             mfr_info["is_apple"],
            "is_microsoft":         mfr_info["is_microsoft"],
            "known_companies":      mfr_info["known_companies"],
            "device_profiles":      profiles,
            "path_loss_db":         _path_loss(adv.rssi, adv.tx_power),
            "service_uuids":        list(adv.service_uuids),
            "manufacturer_data":    {f"0x{k:04X}": v.hex() for k, v in adv.manufacturer_data.items()},
            "service_data":         {str(k): v.hex() for k, v in adv.service_data.items()},
        }

        active_addresses.add(device.address)
        _update_store(device.address, snapshot, ts, adv.rssi, distance_raw)

    async with BleakScanner(callback):
        await asyncio.sleep(timeout)

    scan_time = time.time()
    result = []

    for address, entry in _device_store.items():
        hist     = entry["history"]
        snapshot = entry["snapshot"]
        speeds   = _compute_speeds(hist)
        status   = _movement_status(speeds)

        # Smoothed RSSI and derived fields — reduces single-reading noise
        rssi_smooth = _smooth_rssi(hist)
        dist_smooth = _estimate_distance(rssi_smooth, snapshot.get("tx_power"), n)

        latest = hist[-1]["time"] if hist else scan_time
        history_rel = [
            {"t": round(h["time"] - latest, 1), "rssi": h["rssi"], "distance": h["distance"]}
            for h in hist
        ]

        result.append({
            **snapshot,
            "rssi":                 rssi_smooth,
            "signal_quality_pct":   _signal_quality(rssi_smooth),
            "estimated_distance_m": dist_smooth,
            "active":               address in active_addresses,
            "last_seen_s":          round(scan_time - entry["last_seen"], 1),
            "history":              history_rel,
            "movement_label":       status["label"],
            "movement_cls":         status["cls"],
        })

    return result
