# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Guidelines

- **Do not commit changes to git unless explicitly instructed by the user.** Always propose changes and wait for confirmation before running `git commit` or `git push`.
- **Update CLAUDE.md and README.md on every major change.** Keep both files accurate and concise — remove stale content rather than appending to it. Do not let either file bloat with outdated information.

## Project

Radar is a BLE and WiFi scanner with a Flask REST API backend and a web dashboard. It discovers nearby Bluetooth and WiFi devices and returns rich metadata including estimated distance, signal quality, vendor identification, and movement trends.

## Repository Structure

```
Radar/
├── db/                            # Gitignored — SQLite DB + WAL/SHM files live here
├── server/
│   ├── app/
│   │   ├── __init__.py            # App factory: init SQLAlchemy, register blueprints
│   │   ├── config.py              # Flask config (DB path, SQLAlchemy settings)
│   │   ├── models/
│   │   │   ├── base.py            # db = SQLAlchemy(); WAL/FK pragmas via event hook
│   │   │   ├── bluetooth.py       # BluetoothDevice, BluetoothHistory (ORM models)
│   │   │   └── wifi.py            # WifiDevice, WifiHistory (ORM models)
│   │   ├── core/
│   │   │   ├── distance.py        # DistanceEstimator — path-loss model, signal quality
│   │   │   ├── movement.py        # MovementClassifier — speed derivation, classification
│   │   │   ├── store.py           # DeviceStore — protocol-agnostic in-memory cache
│   │   │   └── scanner.py         # BaseScanner ABC — common scan flow (OCP, LSP)
│   │   ├── bluetooth/
│   │   │   ├── metadata.py        # COMPANY_IDS, SERVICE_PROFILES, BLE helper functions
│   │   │   └── scanner.py         # BluetoothScanner(BaseScanner) — bleak + ORM
│   │   ├── wifi/
│   │   │   ├── metadata.py        # OUI_MAP, WiFi helper functions
│   │   │   └── scanner.py         # WifiScanner(BaseScanner) — nmcli + ORM
│   │   ├── api/
│   │   │   ├── bluetooth.py       # Blueprint: /api/bluetooth/devices, /api/bluetooth/reset
│   │   │   ├── wifi.py            # Blueprint: /api/wifi/devices,      /api/wifi/reset
│   │   │   └── sonar.py           # Blueprint: /api/sonar/snapshot (concurrent BLE+WiFi, fused)
│   │   ├── static/
│   │   │   ├── css/styles.css     # All UI styles
│   │   │   └── scripts/
│   │   │       └── sonar.js       # Sonar dashboard: radar + dual spectrum + modal
│   │   └── templates/
│   │       └── sonar.html         # Main (only) dashboard — fused BLE + WiFi
│   ├── requirements.txt           # flask, flask-sqlalchemy, bleak, python-dotenv
│   ├── .env                       # Local deployment config (gitignored)
│   ├── .env.example               # Template for .env
│   └── run.py                     # Entrypoint: loads .env, starts Flask dev server
├── .gitignore                     # Excludes /db/*.db, /db/*.db-wal, /db/*.db-shm
└── README.md
```

## Running the Server

```bash
cd server
cp .env.example .env        # first time only
pip install -r requirements.txt
sudo venv/bin/python run.py
```

Requires a Bluetooth adapter and either `sudo` or `CAP_NET_RAW` on the Python binary.
WiFi scanning requires `nmcli` (NetworkManager) to be available.

The web UI is served at `http://localhost:5000`. No separate frontend server.

## Architecture — SOLID Design

### Common (protocol-agnostic) flow

```
BaseScanner.get_devices(timeout, environment)
  ├─ _init_store()            [once, lazy]  — load DB → DeviceStore
  ├─ _do_scan()               [abstract]    — BLE callback / nmcli subprocess
  │    └─ returns (readings, active_keys, scan_time)
  ├─ per reading:
  │    ├─ _compute_ewma_rssi() — EWMA α=0.3, 2σ outlier gate
  │    ├─ DeviceStore.update() — raw + smoothed values
  │    └─ _persist_reading()  [abstract]    — ORM upsert + history insert
  ├─ db.session.commit()      [commit 1: scan data]
  ├─ _build_results()         — smoothed RSSI/distance, speed EWMA, hysteresis, format JSON
  │    └─ writes smoothed_speed / movement_state / movement_since back to store entries
  ├─ _persist_movement_state() per device [abstract]
  └─ db.session.commit()      [commit 2: movement state]
```

### Adding a new protocol

1. Create `app/<protocol>/metadata.py` (constants + pure helpers)
2. Create `app/<protocol>/scanner.py` — extend `BaseScanner`, implement the five abstract methods (`_do_scan`, `_ref_rssi`, `_init_store`, `_persist_reading`, `_persist_movement_state`, `_clear_db`)
3. Create `app/models/<protocol>.py` — two ORM models: device + history (include `smoothed_rssi`, `is_outlier` on history; `smoothed_speed`, `movement_state`, `movement_since` on device)
4. Create `app/api/<protocol>.py` — Blueprint with `/devices` GET and `/reset` POST
5. Register blueprint in `app/__init__.py` and import models for `db.create_all()`

## Key Design Decisions

- **ORM**: Flask-SQLAlchemy 3.x with SQLAlchemy 2.x declarative models. No raw SQL. JSON columns handled transparently (lists/dicts auto-serialised).
- **DB location**: `db/radar.db` at the project root (not inside `server/`). WAL and SHM journal files co-locate automatically and are all gitignored.
- **WAL mode**: Enabled per-connection via a `@event.listens_for(Engine, "connect")` hook in `models/base.py`.
- **bleak** is used for BLE scanning (not scapy). `asyncio.run()` wraps the async scan inside a synchronous `_do_scan`.
- **WiFi scanning** uses `nmcli --rescan yes` via `subprocess`. Output parsed per-line; BSSID colons unescaped from nmcli terse format.
- **Distance estimation**: log-distance path-loss model `10 ^ ((ref - rssi) / (10 * n))`. BLE ref = `tx_power` (default `-59 dBm`); WiFi ref is frequency-corrected: 2.4 GHz → `-40 dBm`, 5 GHz → `-45 dBm`, 6 GHz → `-48 dBm`.
- **Environment profiles** control path-loss exponent `n`: `outdoor` (2.0), `indoor_open` (2.5), `indoor_mixed` (3.0, default), `indoor_dense` (3.5).
- **RSSI smoothing**: EWMA (α=0.3) with a 2σ outlier gate over the last 10 readings. Smoothed RSSI is stored in history so the running state survives restarts.
- **Movement classification** in `MovementClassifier`: speed EWMA (β=0.4) + hysteresis (3/4 confirmation before state change). State and EWMA seed are persisted on device rows. Returned as `movement_label` / `movement_cls`.
- **In-memory DeviceStore**: populated once from DB (lazy), updated on every reading. Two commits per scan — one for readings, one for movement state after `_build_results`.
- **History trimmed** to 60 rows per device: after each `flush()`, a subquery deletes the oldest rows beyond the limit.
- **Sonar concurrent scan**: `ThreadPoolExecutor(max_workers=2)` runs BLE and WiFi in parallel; each thread pushes its own Flask app context via `_run_in_app_context`.
- **Radar scale**: logarithmic — `logR(d) = log(d+1) / log(MAX+1) * R`. Selectable range: 15/30/50/75/100 m.
- **Pseudo-angles**: `MD5(device_id)[:8] % 360` — deterministic, stable across polls. True bearing requires AoA/AoD hardware.
- **Schema migrations**: `db.create_all()` creates new DBs; `models/migrations.py:migrate_db()` applies idempotent `ALTER TABLE` additions for existing DBs. Called automatically at startup. Use Alembic for destructive changes.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Redirects to `/dashboard/sonar` |
| GET | `/dashboard/sonar` | Main dashboard — fused radar + dual spectrum + device modal |
| GET | `/api/sonar/snapshot` | Concurrent BLE + WiFi scan; fused device list with `angle_deg` |
| GET | `/api/bluetooth/devices` | Scan and return nearby BLE devices |
| POST | `/api/bluetooth/reset` | Clear all BLE device history |
| GET | `/api/wifi/devices` | Scan and return nearby WiFi networks |
| POST | `/api/wifi/reset` | Clear all WiFi device history |

Query params for all scan endpoints:
- `timeout` (float, default `5.0`) — scan duration in seconds
- `environment` (string, default `indoor_mixed`) — one of `outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense`

## Database Schema

```
bluetooth_devices   address (PK), name, tx_power, address_type, is_apple, is_microsoft,
                    known_companies (JSON), device_profiles (JSON), service_uuids (JSON),
                    manufacturer_data (JSON), service_data (JSON), last_seen_at, created_at,
                    smoothed_speed, movement_state, movement_since

bluetooth_history   id (PK), address (FK → bluetooth_devices, CASCADE),
                    rssi, distance, smoothed_rssi, is_outlier, recorded_at

wifi_devices        bssid (PK), ssid, frequency_mhz, channel, band, security, vendor,
                    last_seen_at, created_at,
                    smoothed_speed, movement_state, movement_since

wifi_history        id (PK), bssid (FK → wifi_devices, CASCADE),
                    rssi, distance, smoothed_rssi, is_outlier, recorded_at
```

New DBs are created automatically by `db.create_all()` on startup. Existing DBs are migrated by `models/migrations.py:migrate_db()` (idempotent `ALTER TABLE`, runs automatically).
