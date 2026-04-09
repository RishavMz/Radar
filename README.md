# Radar

Radar is a BLE (Bluetooth Low Energy) device scanner with a REST API and a built-in web dashboard. It discovers nearby Bluetooth devices and exposes rich metadata — including estimated distance, signal quality, device profiles, and vendor identification. The dashboard auto-polls every 10 seconds and visualises per-device RSSI and speed history with SVG sparklines.

## Project Structure

```
Radar/
├── server/                        # Flask server — API + frontend
│   ├── app/
│   │   ├── api/
│   │   │   └── routes.py          # REST endpoints (/api/devices)
│   │   ├── bluetooth/
│   │   │   └── scanner.py         # BLE scanning logic (bleak)
│   │   ├── static/
│   │   │   ├── css/styles.css     # Dashboard styles
│   │   │   └── scripts/app.js     # Dashboard logic
│   │   └── templates/
│   │       └── index.html         # Dashboard page
│   ├── requirements.txt
│   └── run.py
└── README.md
```

## Server Setup

### Prerequisites

- Python 3.12+
- A system with a Bluetooth adapter (`hci0` or similar)
- Linux with BlueZ installed (`bluez` package)

### Install dependencies

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Run the server

BLE scanning requires elevated privileges:

```bash
sudo venv/bin/python run.py
```

Alternatively, grant the capability once to avoid using `sudo` every time:

```bash
sudo setcap cap_net_raw+eip venv/bin/python3.12
venv/bin/python run.py
```

The server starts on `http://0.0.0.0:5000` by default.

Open **http://localhost:5000** in a browser to access the dashboard.

## API

### `GET /api/devices`

Scans for nearby BLE devices and returns a list with metadata.

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `5.0`   | Scan duration in seconds |

**Example:**

```bash
curl http://localhost:5000/api/devices
curl "http://localhost:5000/api/devices?timeout=10"
```

**Response:**

```json
{
  "count": 2,
  "devices": [
    {
      "address": "AA:BB:CC:DD:EE:FF",
      "name": "My Speaker",
      "rssi": -65,
      "tx_power": -59,
      "estimated_distance_m": 3.98,
      "signal_quality_pct": 50,
      "path_loss_db": 6,
      "address_type": "public",
      "is_apple": false,
      "is_microsoft": false,
      "known_companies": [],
      "device_profiles": ["Audio Sink"],
      "service_uuids": ["0000110b-0000-1000-8000-00805f9b34fb"],
      "manufacturer_data": {},
      "service_data": {}
    }
  ]
}
```

**Device fields:**

| Field | Description |
|-------|-------------|
| `address` | Bluetooth MAC address |
| `name` | Advertised device name (`"Unknown"` if not present) |
| `rssi` | Received signal strength in dBm |
| `tx_power` | Advertised TX power in dBm (`null` if not present) |
| `estimated_distance_m` | Estimated distance in metres (log-distance path-loss model) |
| `signal_quality_pct` | Signal quality 0–100% (mapped from RSSI -100 to -30 dBm) |
| `path_loss_db` | Path loss in dB (`tx_power - rssi`), `null` if TX power unavailable |
| `address_type` | `"random"` or `"public"` (derived from MAC address) |
| `is_apple` | `true` if manufacturer data contains Apple's company ID (`0x004C`) |
| `is_microsoft` | `true` if manufacturer data contains Microsoft's company ID (`0x0006`) |
| `known_companies` | List of recognized vendor names from manufacturer data |
| `device_profiles` | List of BLE profiles inferred from service UUIDs (e.g. `"Heart Rate"`, `"HID"`) |
| `service_uuids` | Raw list of advertised service UUIDs |
| `manufacturer_data` | Raw manufacturer data keyed by company ID |
| `service_data` | Raw service data keyed by UUID |
