# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Radar is a BLE (Bluetooth Low Energy) device scanner with a Flask REST API. A background job continuously scans for nearby devices and persists readings to SQLite. A separate purge job deletes records older than 2 minutes. The API returns one entry per distinct device, enriched with Kalman-filtered motion analysis.

## Repository Structure

```
Radar/
├── server/
│   ├── app/
│   │   ├── __init__.py          # App factory: wires extensions, registers blueprints, starts scheduler
│   │   ├── extensions.py        # SQLAlchemy + Flask-Migrate singletons (avoids circular imports)
│   │   ├── models.py            # BLEDevice ORM model + to_dict()
│   │   ├── analysis.py          # Kalman filter, distance, speed, trend analysis
│   │   ├── api/
│   │   │   └── routes.py        # GET /api/devices — queries DB, runs analysis
│   │   └── bluetooth/
│   │       └── scanner.py       # BLE scanning via bleak (async, wrapped with asyncio.run)
│   ├── config/
│   │   └── settings.py          # Config classes (Dev/Prod), all values read from os.getenv
│   ├── migrations/              # Flask-Migrate / Alembic migrations
│   ├── requirements.txt
│   ├── run.py                   # Entrypoint: loads .env, starts Flask dev server
│   ├── .env                     # Local config (gitignored)
│   └── .env.example             # Committed template for .env
└── README.md
```

## Running the Server

```bash
cd server
cp .env.example .env
pip install -r requirements.txt
FLASK_APP=run.py venv/bin/flask db upgrade   # apply migrations
sudo venv/bin/python run.py
```

Or grant capability once to avoid sudo:
```bash
sudo setcap cap_net_raw,cap_net_admin+eip venv/bin/python3.12
venv/bin/python run.py
```

## Key Design Decisions

- **bleak** is used for BLE scanning (not scapy). Scapy's AsyncSniffer uses libpcap which doesn't support HCI interfaces on Linux.
- The scanner is synchronous (`get_bluetooth_devices`) wrapping an async bleak scan via `asyncio.run()`. It is called only by the background scheduler, never by API routes.
- **APScheduler** runs two background jobs: `_scan_and_store` (every `BLE_SCAN_INTERVAL_SECONDS`) and `_purge_old_devices` (every `PURGE_INTERVAL_SECONDS`). `max_instances=1` on the scan job prevents overlapping scans.
- **extensions.py** holds the `db` and `migrate` singletons so `models.py` can import them without circular imports with `__init__.py`.
- All constants come from `.env` via `os.getenv`. `load_dotenv()` is called at the top of `run.py` before any app import.
- **Motion analysis** (`analysis.py`): 1D Kalman filter on RSSI → smoothed distance via log-distance path-loss → median Δd/Δt for speed → OLS regression slope for trend.
- Distance estimation: `10 ^ ((tx_power - rssi) / (10 * n))`, configurable via `BLE_DEFAULT_TX_POWER` and `BLE_PATH_LOSS_N`.
- `address_type` is derived from the MAC address first byte (≥ 0xC0 → random).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/devices` | Returns latest record + motion analysis per distinct device |

No query parameters — scanning is continuous and independent of the API.
