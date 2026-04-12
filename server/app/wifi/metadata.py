"""
WiFi-specific metadata helpers.

Contains the OUI vendor lookup table and pure functions for parsing nmcli
output, converting signal quality, and classifying frequency bands.
"""

import re

# Reference RSSI at 1 m varies by band — 5 GHz has ~5 dB higher free-space path
# loss vs 2.4 GHz, and 6 GHz adds another ~3 dB on top.
def ref_rssi_for_freq(freq_mhz: int) -> float:
    """Return the appropriate 1-metre reference RSSI for a given frequency."""
    if freq_mhz >= 6000:
        return -48.0
    if freq_mhz >= 5000:
        return -45.0
    return -40.0

# OUI prefix (first 3 octets, upper-case, colon-separated) → vendor name.
OUI_MAP: dict[str, str] = {
    # Apple
    "00:17:F2": "Apple",  "00:1B:63": "Apple",  "00:25:00": "Apple",
    "00:26:BB": "Apple",  "3C:07:54": "Apple",  "98:01:A7": "Apple",
    "A4:C3:61": "Apple",  "D8:BB:2C": "Apple",  "F0:DB:F8": "Apple",
    # Google / Nest
    "3C:5A:B4": "Google", "00:1A:11": "Google", "54:60:09": "Google",
    "94:EB:2C": "Google", "F4:F5:D8": "Google", "20:DF:B9": "Google",
    "48:D6:D5": "Google",
    # TP-Link
    "18:74:2E": "TP-Link", "50:C7:BF": "TP-Link", "60:32:B1": "TP-Link",
    "98:DA:C4": "TP-Link", "B0:48:7A": "TP-Link", "EC:08:6B": "TP-Link",
    "F8:1A:67": "TP-Link", "DC:FE:18": "TP-Link", "C4:6E:1F": "TP-Link",
    # Netgear
    "00:14:6C": "Netgear", "00:1B:2F": "Netgear", "A0:21:B7": "Netgear",
    "2C:30:33": "Netgear", "30:46:9A": "Netgear", "44:94:FC": "Netgear",
    "20:0C:C8": "Netgear", "84:1B:5E": "Netgear",
    # Cisco
    "00:0C:41": "Cisco",   "00:1A:2B": "Cisco",   "68:86:A7": "Cisco",
    "00:26:CB": "Cisco",   "FC:FB:FB": "Cisco",
    # Linksys
    "00:17:DF": "Linksys", "00:25:9C": "Linksys", "00:1E:E5": "Linksys",
    # Asus
    "00:11:D8": "Asus",   "00:15:F2": "Asus",   "04:92:26": "Asus",
    "10:02:B5": "Asus",   "50:46:5D": "Asus",   "BC:EE:7B": "Asus",
    "2C:FD:A1": "Asus",
    # D-Link
    "00:0D:88": "D-Link", "00:11:95": "D-Link", "00:1C:F0": "D-Link",
    "1C:7E:E5": "D-Link", "90:94:E4": "D-Link", "C8:BE:19": "D-Link",
    # Ubiquiti
    "04:18:D6": "Ubiquiti", "24:A4:3C": "Ubiquiti", "44:D9:E7": "Ubiquiti",
    "68:72:51": "Ubiquiti", "74:83:C2": "Ubiquiti", "DC:9F:DB": "Ubiquiti",
    "F0:9F:C2": "Ubiquiti", "80:2A:A8": "Ubiquiti",
    # Huawei
    "00:18:82": "Huawei", "00:9A:CD": "Huawei", "04:BD:70": "Huawei",
    "54:89:98": "Huawei", "70:72:3C": "Huawei", "AC:61:EA": "Huawei",
    # Samsung
    "00:02:78": "Samsung", "34:23:BA": "Samsung", "8C:77:12": "Samsung",
    "78:BD:BC": "Samsung",
    # Microsoft
    "00:50:F2": "Microsoft", "28:18:78": "Microsoft",
    # Eero
    "F8:BB:BF": "Eero", "50:91:E3": "Eero", "A4:11:63": "Eero",
    # Aruba / HP
    "00:0B:86": "Aruba", "20:4C:03": "Aruba", "D8:C7:C8": "Aruba",
    "84:D4:7E": "Aruba",
    # MikroTik
    "00:0C:42": "MikroTik", "2C:C8:1B": "MikroTik", "64:D1:54": "MikroTik",
    # Xiaomi
    "50:64:2B": "Xiaomi", "28:6C:07": "Xiaomi", "AC:C1:EE": "Xiaomi",
}


def oui_vendor(bssid: str) -> str | None:
    """Look up vendor from the first 3 octets (OUI) of a BSSID."""
    return OUI_MAP.get(bssid.upper()[:8])


def freq_to_band(freq_mhz: int) -> str:
    """Classify a frequency in MHz to a WiFi band string."""
    if freq_mhz < 3000:
        return "2.4 GHz"
    if freq_mhz < 6000:
        return "5 GHz"
    return "6 GHz"


def quality_to_dbm(quality: int) -> int:
    """Convert nmcli 0–100 quality score to approximate dBm (-100 to -50)."""
    return (quality // 2) - 100


def parse_nmcli_line(line: str) -> list[str]:
    """Split nmcli terse output on unescaped colons, then unescape each field.

    nmcli --terse escapes colons inside field values as \\:, so a BSSID like
    AA:BB:CC:DD:EE:FF appears as AA\\:BB\\:CC\\:DD\\:EE\\:FF in the output.
    """
    parts = re.split(r'(?<!\\):', line)
    return [p.replace('\\:', ':') for p in parts]
