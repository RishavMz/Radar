"""
BLE-specific metadata helpers.

Contains the manufacturer company ID table, BLE service profile UUID map,
and pure functions for extracting metadata from BLE advertisement data.
"""

# Manufacturer-specific company identifiers (Bluetooth SIG assigned numbers).
COMPANY_IDS: dict[int, str] = {
    0x004C: "Apple",
    0x0006: "Microsoft",
    0x0075: "Samsung",
    0x00E0: "Google",
    0x0157: "Garmin",
    0x01D5: "Fitbit",
}

# BLE GATT service UUIDs (full 128-bit, lower-case) → human-readable profile name.
SERVICE_PROFILES: dict[str, str] = {
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


def manufacturer_info(manufacturer_data: dict[int, bytes]) -> dict:
    """Extract vendor flags and known company names from BLE manufacturer data."""
    companies = [name for cid, name in COMPANY_IDS.items() if cid in manufacturer_data]
    return {
        "is_apple":        0x004C in manufacturer_data,
        "is_microsoft":    0x0006 in manufacturer_data,
        "known_companies": companies,
    }


def device_profiles(service_uuids: list[str]) -> list[str]:
    """Map advertised service UUIDs to human-readable profile names."""
    return [
        profile
        for uuid in service_uuids
        if (profile := SERVICE_PROFILES.get(uuid.lower()))
    ]


def address_type(address: str) -> str:
    """Classify a BLE MAC address as 'random' or 'public' from its first byte."""
    first_byte = int(address.split(":")[0], 16)
    return "random" if first_byte >= 0xC0 else "public"


def path_loss(rssi: int, tx_power: int | None) -> int | None:
    """Compute path loss in dB when TX power is known."""
    return (tx_power - rssi) if tx_power is not None else None
