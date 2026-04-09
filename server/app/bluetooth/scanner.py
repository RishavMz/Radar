import asyncio
import os
from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

# Assumed TX power at 1 metre when device doesn't advertise one (dBm)
_DEFAULT_TX_POWER = int(os.getenv("BLE_DEFAULT_TX_POWER", -59))
# Path-loss exponent: 2.0 = free space, 2–3 typical indoors
_PATH_LOSS_N = float(os.getenv("BLE_PATH_LOSS_N", 2.0))

_COMPANY_IDS = {
    0x004C: "Apple",
    0x0006: "Microsoft",
    0x0075: "Samsung",
    0x00E0: "Google",
    0x0157: "Garmin",
    0x01D5: "Fitbit",
}

# Maps service UUID (lowercase, no braces) -> human-readable profile name
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


def _estimate_distance(rssi: int, tx_power: int | None) -> float | None:
    if rssi >= 0:
        return None
    ref = tx_power if tx_power is not None else _DEFAULT_TX_POWER
    return round(10 ** ((ref - rssi) / (10 * _PATH_LOSS_N)), 2)


def _signal_quality(rssi: int) -> int:
    """Map RSSI (dBm) to 0–100% quality."""
    clamped = max(-100, min(-30, rssi))
    return round((clamped + 100) / 70 * 100)


def _path_loss(rssi: int, tx_power: int | None) -> int | None:
    if tx_power is None:
        return None
    return tx_power - rssi


def _address_type(address: str) -> str:
    """Derive BLE address type from the first byte of the MAC address."""
    first_byte = int(address.split(":")[0], 16)
    return "random" if first_byte >= 0xC0 else "public"


def _manufacturer_info(manufacturer_data: dict[int, bytes]) -> dict:
    companies = []
    for company_id, _ in manufacturer_data.items():
        name = _COMPANY_IDS.get(company_id)
        if name:
            companies.append(name)
    return {
        "is_apple": 0x004C in manufacturer_data,
        "is_microsoft": 0x0006 in manufacturer_data,
        "known_companies": companies,
    }


def _device_profiles(service_uuids: list[str]) -> list[str]:
    profiles = []
    for uuid in service_uuids:
        profile = _SERVICE_PROFILES.get(uuid.lower())
        if profile:
            profiles.append(profile)
    return profiles


def get_bluetooth_devices(timeout: float = 5.0) -> list[dict]:
    """Scan for nearby BLE devices using BlueZ via bleak."""
    return asyncio.run(_scan(timeout))


async def _scan(timeout: float) -> list[dict]:
    devices: dict[str, dict] = {}

    def callback(device: BLEDevice, adv: AdvertisementData):
        if device.address in devices:
            return

        mfr_info = _manufacturer_info(adv.manufacturer_data)
        profiles = _device_profiles(adv.service_uuids)

        devices[device.address] = {
            "address": device.address,
            "name": device.name or adv.local_name or "Unknown",
            "rssi": adv.rssi,
            "tx_power": adv.tx_power,
            # Derived fields
            "estimated_distance_m": _estimate_distance(adv.rssi, adv.tx_power),
            "signal_quality_pct": _signal_quality(adv.rssi),
            "path_loss_db": _path_loss(adv.rssi, adv.tx_power),
            "address_type": _address_type(device.address),
            "is_apple": mfr_info["is_apple"],
            "is_microsoft": mfr_info["is_microsoft"],
            "known_companies": mfr_info["known_companies"],
            "device_profiles": profiles,
            # Raw data
            "service_uuids": adv.service_uuids,
            "manufacturer_data": {
                f"0x{k:04X}": v.hex() for k, v in adv.manufacturer_data.items()
            },
            "service_data": {
                str(k): v.hex() for k, v in adv.service_data.items()
            },
        }

    async with BleakScanner(callback) as scanner:
        await asyncio.sleep(timeout)

    return list(devices.values())
