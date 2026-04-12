This is a simple BLE + WiFi scanner with a Flask REST API and a unified web dashboard. It discovers nearby Bluetooth and WiFi devices, estimates distances using a log-distance path-loss model with EWMA-smoothed RSSI, identifies vendors, and classifies movement with hysteresis. All history is persisted to SQLite.

<img width="1854" height="1048" alt="Screenshot from 2026-04-12 10-55-31" src="https://github.com/user-attachments/assets/e01bb434-5f71-43c3-bc45-992bd7d2643c" />


## Structure

```
Radar/
├── db/                            # Gitignored — SQLite DB + WAL/SHM files
├── server/
│   ├── app/
│   │   ├── __init__.py            # App factory
│   │   ├── config.py              # Flask + DB config
│   │   ├── models/                # SQLAlchemy ORM models (bluetooth, wifi)
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

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
sudo venv/bin/python run.py
```

Requires a Bluetooth adapter and `nmcli` (NetworkManager) for WiFi. Use `sudo` or grant `cap_net_raw` to the Python binary.

Open **http://localhost:5000** — the dashboard loads automatically.

## Dashboard

A single **Sonar** view at `/dashboard/sonar` shows:

- **Polar radar** — BLE and WiFi devices plotted on a logarithmic radial scale (15–100 m selectable). Dot size scales with signal strength; a glow indicates approaching devices. Hover a dot for name, distance, and RSSI.
- **Dual spectrum** — BLE (2.4 GHz) and WiFi (2.4/5/6 GHz) frequency strips below the radar. Hover a bar to highlight the corresponding device in the sidebar.
- **Device sidebar** — split BLE / WiFi sections. Hover a row to open a detail modal with RSSI + distance history graphs.
- **Controls** — Range (15–100 m), Environment (outdoor → indoor dense), Timeout, Scan / Auto-poll.

Angular positions are hash-derived (stable per device). True bearing requires multi-antenna hardware.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sonar/snapshot` | Concurrent BLE + WiFi scan; fused device list |
| GET | `/api/bluetooth/devices` | BLE scan |
| POST | `/api/bluetooth/reset` | Clear BLE history |
| GET | `/api/wifi/devices` | WiFi scan |
| POST | `/api/wifi/reset` | Clear WiFi history |

Query params for all scan endpoints: `timeout` (float, default `5.0`) and `environment` (`outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense`).
