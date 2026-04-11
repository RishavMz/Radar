# Radar

Radar is a BLE and WiFi scanner with a REST API and a built-in web dashboard. It discovers nearby Bluetooth and WiFi devices and exposes rich metadata — including estimated distance, signal quality, device profiles, and vendor identification. The dashboard auto-polls every 10 seconds and visualises per-device RSSI and distance history as time-series graphs with grid lines, area fills, and labeled axes. All device history is persisted to SQLite across server restarts.

## Project Structure

```
Radar/
├── server/
│   ├── app/
│   │   ├── api/
│   │   │   ├── routes.py          # BLE endpoints
│   │   │   └── wifi_routes.py     # WiFi endpoints
│   │   ├── bluetooth/
│   │   │   └── scanner.py         # BLE scanning logic (bleak)
│   │   ├── wifi/
│   │   │   └── scanner.py         # WiFi scanning logic (nmcli)
│   │   ├── static/
│   │   │   ├── css/styles.css     # Dashboard styles
│   │   │   └── scripts/
│   │   │       ├── app.js         # Bluetooth dashboard logic
│   │   │       └── wifi.js        # WiFi dashboard logic
│   │   ├── templates/
│   │   │   ├── bluetooth.html     # BLE dashboard
│   │   │   └── wifi.html          # WiFi dashboard
│   │   └── db.py                  # SQLite connection + migration runner
│   ├── migrations/
│   │   └── 001_initial.sql        # Schema: 4 tables for BLE and WiFi
│   ├── requirements.txt
│   ├── .env.example
│   └── run.py
└── README.md
```

## Server Setup

### Prerequisites

- Python 3.12+
- A system with a Bluetooth adapter (`hci0` or similar)
- Linux with BlueZ installed (`bluez` package)
- `nmcli` (NetworkManager) for WiFi scanning

### Install dependencies

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Configure environment

```bash
cp .env.example .env
```

Edit `.env` if you need to change the host, port, or database path. The defaults work out of the box.

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

The server starts on `http://0.0.0.0:5000` by default. Database migrations run automatically on startup — no manual steps needed.

Open **http://localhost:5000** in a browser to access the dashboard.

## Dashboard

The dashboard has two modes, selectable via the nav in the header:

- **Bluetooth** (`/dashboard/bluetooth`) — scans for nearby BLE devices using the system Bluetooth adapter.
- **WiFi** (`/dashboard/wifi`) — scans for nearby WiFi access points using `nmcli`.

Both modes share the same controls:

- **Environment selector** — choose `Outdoor`, `Indoor – Open`, `Indoor – Mixed`, or `Indoor – Dense` to tune the path-loss model.
- **Scan / Auto** — trigger a single scan or enable auto-polling every 10 seconds.
- **Clear Data** — wipe all stored device history from memory and the database.
- **Filter / Sort** — filter cards by name/address/vendor; sort by signal, distance, name, or quality.
- Per-device cards with RSSI bar, signal quality, estimated distance, movement status, and two time-series graphs (RSSI history and distance history).

## Database

Device history is stored in SQLite (`radar.db` by default, configurable via `DATABASE_URL` in `.env`).

### Schema

| Table | Key | Description |
|-------|-----|-------------|
| `bluetooth_devices` | `address` | Latest snapshot of each BLE device |
| `bluetooth_history` | `id` | Per-scan RSSI and distance readings for BLE |
| `wifi_devices` | `bssid` | Latest snapshot of each WiFi access point |
| `wifi_history` | `id` | Per-scan RSSI and distance readings for WiFi |

### Migrations

Migration files live in `server/migrations/`. They are applied automatically in alphabetical order when the server starts. To add a migration, create a new `.sql` file:

```
server/migrations/002_my_change.sql
```

## API

### `GET /api/bluetooth/devices`

Scans for nearby BLE devices and returns all known devices (active and stale from previous scans).

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `5.0` | Scan duration in seconds |
| `environment` | `indoor_mixed` | Path-loss profile: `outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense` |

```bash
curl http://localhost:5000/api/bluetooth/devices
curl "http://localhost:5000/api/bluetooth/devices?timeout=10&environment=outdoor"
```

### `POST /api/bluetooth/reset`

Clears all BLE device history from memory and the database.

```bash
curl -X POST http://localhost:5000/api/bluetooth/reset
```

---

### `GET /api/wifi/devices`

Scans for nearby WiFi access points using `nmcli` and returns all known networks.

**Query parameters:** same as `/api/bluetooth/devices`.

```bash
curl http://localhost:5000/api/wifi/devices
curl "http://localhost:5000/api/wifi/devices?timeout=10&environment=indoor_open"
```

**Response fields:**

| Field | Description |
|-------|-------------|
| `bssid` | MAC address of the access point |
| `ssid` | Network name (`"Hidden"` if not broadcast) |
| `rssi` | Smoothed signal strength in dBm |
| `signal_quality_pct` | Signal quality 0–100% |
| `estimated_distance_m` | Estimated distance in metres |
| `frequency_mhz` | Channel frequency (e.g. `2437`) |
| `channel` | WiFi channel number |
| `band` | `"2.4 GHz"`, `"5 GHz"`, or `"6 GHz"` |
| `security` | `"Open"`, `"WPA2"`, `"WPA3"`, etc. |
| `vendor` | Vendor name from OUI lookup (may be `null`) |
| `active` | `true` if seen in the most recent scan |
| `last_seen_s` | Seconds since last seen |
| `movement_label` | e.g. `"Stationary"`, `"Getting closer"` |
| `movement_cls` | `stable`, `closer`, `away`, or `tracking` |
| `history` | `[{t, rssi, distance}, …]` — `t=0` is most recent |

### `POST /api/wifi/reset`

Clears all WiFi history from memory and the database.

```bash
curl -X POST http://localhost:5000/api/wifi/reset
```
