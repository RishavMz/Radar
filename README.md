# Radar

Radar is a BLE + WiFi scanner with a Flask REST API and a unified web dashboard. It discovers nearby Bluetooth and WiFi devices, estimates distances, identifies vendors, and classifies movement. All history is persisted to SQLite across server restarts.

For a full explanation of the distance estimation, RSSI smoothing, and movement classification algorithms see [`resources/ALGORITHM.md`](resources/ALGORITHM.md).

<img width="1854" height="1048" alt="Screenshot from 2026-04-12 10-55-31" src="https://github.com/user-attachments/assets/e01bb434-5f71-43c3-bc45-992bd7d2643c" />

## Project Structure

```
Radar/
├── db/                            # Gitignored — SQLite DB + WAL/SHM files
├── resources/
│   └── ALGORITHM.md               # Algorithm deep-dive
├── server/
│   ├── app/
│   │   ├── __init__.py            # App factory
│   │   ├── config.py              # Flask + DB config
│   │   ├── models/                # SQLAlchemy ORM models + startup migrations
│   │   ├── core/                  # BaseScanner, DeviceStore, DistanceEstimator, MovementClassifier
│   │   ├── bluetooth/             # BLE scanner (bleak) + metadata
│   │   ├── wifi/                  # WiFi scanner (nmcli) + metadata
│   │   ├── api/                   # Blueprints: bluetooth, wifi, sonar
│   │   ├── static/
│   │   │   ├── css/styles.css
│   │   │   └── scripts/sonar.js   # Radar + spectrum + modal logic
│   │   └── templates/sonar.html   # Single dashboard page
│   ├── requirements.txt
│   ├── .env.example
│   └── run.py
└── README.md
```

## Setup

### Prerequisites

- Python 3.12+
- A Bluetooth adapter (Linux BlueZ)
- `nmcli` (NetworkManager) for WiFi scanning

### Install

```bash
cd server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` to change the host, port, or database path. Defaults work out of the box.

### Run

BLE scanning requires elevated privileges:

```bash
sudo venv/bin/python run.py
```

Or grant the capability once to avoid `sudo` on every run:

```bash
sudo setcap cap_net_raw+eip venv/bin/python3.12
venv/bin/python run.py
```

Open **http://localhost:5000** — the dashboard loads automatically. Schema migrations run on startup with no manual steps needed.

## Dashboard

A single **Sonar** view at `/dashboard/sonar` shows:

- **Polar radar** — BLE and WiFi devices plotted on a logarithmic radial scale (15–100 m selectable). Dot size scales with signal strength; a glow indicates approaching devices.
- **Dual spectrum** — BLE (2.4 GHz) and WiFi (2.4/5/6 GHz) frequency strips. Hover a bar to highlight the corresponding device.
- **Device sidebar** — split BLE / WiFi sections with per-device cards showing RSSI, distance, movement status, and history graphs.
- **Controls** — Range, Environment (outdoor → indoor dense), Timeout, Scan / Auto-poll.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sonar/snapshot` | Concurrent BLE + WiFi scan; fused device list |
| GET | `/api/bluetooth/devices` | BLE scan |
| POST | `/api/bluetooth/reset` | Clear BLE history |
| GET | `/api/wifi/devices` | WiFi scan |
| POST | `/api/wifi/reset` | Clear WiFi history |

Query params for all scan endpoints:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeout` | `5.0` | Scan duration in seconds |
| `environment` | `indoor_mixed` | `outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense` |

```bash
curl http://localhost:5000/api/sonar/snapshot
curl "http://localhost:5000/api/bluetooth/devices?timeout=10&environment=outdoor"
curl -X POST http://localhost:5000/api/bluetooth/reset
```

**Response fields (per device):**

| Field | Description |
|-------|-------------|
| `rssi` | Smoothed signal strength (dBm) |
| `signal_quality_pct` | Signal quality 0–100% |
| `estimated_distance_m` | Estimated distance in metres |
| `active` | `true` if seen in the most recent scan |
| `last_seen_s` | Seconds since last seen |
| `movement_label` | e.g. `"Stationary"`, `"Getting closer"` |
| `movement_cls` | `stable`, `closer`, `away`, or `tracking` |
| `history` | `[{t, rssi, distance}, …]` — `t=0` is most recent |

## Database

SQLite at `db/radar.db` (configurable via `DATABASE_URL` in `.env`).

| Table | Key | Description |
|-------|-----|-------------|
| `bluetooth_devices` | `address` | Latest snapshot per BLE device |
| `bluetooth_history` | `id` | Per-scan RSSI, distance, and smoothed values |
| `wifi_devices` | `bssid` | Latest snapshot per WiFi AP |
| `wifi_history` | `id` | Per-scan RSSI, distance, and smoothed values |

Schema additions are applied automatically at startup via `models/migrations.py` (idempotent `ALTER TABLE`).
