# Radar

Radar is a BLE (Bluetooth Low Energy) device scanner with a REST API and a built-in web dashboard. It discovers nearby Bluetooth devices and exposes rich metadata — including estimated distance, signal quality, device profiles, and vendor identification. The dashboard auto-polls every 10 seconds and visualises per-device RSSI and distance history as time-series graphs with grid lines, area fills, and labeled axes.

## Project Structure

```
Radar/
├── server/                        # Flask server — API + frontend
│   ├── app/
│   │   ├── api/
│   │   │   └── routes.py          # REST endpoints (/api/devices, /api/reset)
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

## Dashboard

The dashboard provides:

- **Environment selector** — choose `Outdoor`, `Indoor – Open`, `Indoor – Mixed`, or `Indoor – Dense` to tune the path-loss model before scanning. Denser environments use a higher path-loss exponent for more accurate distance estimates.
- **Scan / Auto** — trigger a single scan or enable auto-polling every 10 seconds.
- **Clear Data** — wipe all stored device history on the server and reset the view.
- **Filter / Sort** — filter cards by name, address, or profile; sort by signal strength, distance, name, or quality.
- Per-device cards showing RSSI, signal quality, estimated distance, movement status, and two time-series graphs (RSSI history and distance history).

## API

### `GET /api/devices`

Scans for nearby BLE devices and returns all known devices (active and stale from previous scans).

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `5.0` | Scan duration in seconds |
| `environment` | `indoor_mixed` | Path-loss profile: `outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense` |

**Example:**

```bash
curl http://localhost:5000/api/devices
curl "http://localhost:5000/api/devices?timeout=10&environment=outdoor"
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
      "service_data": {},
      "active": true,
      "last_seen_s": 0.0,
      "movement_label": "Stationary",
      "movement_cls": "stable",
      "history": [{"t": -30.0, "rssi": -67, "distance": 4.2}, {"t": 0, "rssi": -65, "distance": 3.98}]
    }
  ]
}
```

**Device fields:**

| Field | Description |
|-------|-------------|
| `address` | Bluetooth MAC address |
| `name` | Advertised device name (`"Unknown"` if not present) |
| `rssi` | Smoothed RSSI in dBm (averaged over last 5 readings) |
| `tx_power` | Advertised TX power in dBm (`null` if not present) |
| `estimated_distance_m` | Estimated distance in metres (log-distance path-loss model, smoothed RSSI) |
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
| `active` | `true` if device was seen in the most recent scan |
| `last_seen_s` | Seconds since device was last seen |
| `movement_label` | Human-readable movement status (e.g. `"Stationary"`, `"Getting closer"`) |
| `movement_cls` | CSS class for movement: `stable`, `closer`, `away`, or `tracking` |
| `history` | Array of `{t, rssi, distance}` readings; `t=0` is the most recent |

---

### `POST /api/reset`

Clears all stored device history on the server.

**Example:**

```bash
curl -X POST http://localhost:5000/api/reset
```

**Response:**

```json
{"ok": true}
```
