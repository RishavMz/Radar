# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Guidelines

- **Do not commit changes to git unless explicitly instructed by the user.** Always propose changes and wait for confirmation before running `git commit` or `git push`.

## Project

Radar is a BLE (Bluetooth Low Energy) device scanner with a Flask REST API backend. It discovers nearby Bluetooth devices and returns rich metadata including distance estimates, signal quality, vendor identification, and device profiles.

## Repository Structure

```
Radar/
├── server/                        # Flask server — API + frontend
│   ├── app/
│   │   ├── __init__.py            # App factory (create_app); serves / via render_template
│   │   ├── api/
│   │   │   └── routes.py          # REST endpoints (/api/devices, /api/reset)
│   │   ├── bluetooth/
│   │   │   └── scanner.py         # BLE scanning via bleak; device store; movement logic
│   │   ├── static/
│   │   │   ├── css/styles.css     # All UI styles
│   │   │   └── scripts/app.js     # Frontend logic (polling, graphs, status)
│   │   └── templates/
│   │       └── index.html         # Main page template
│   ├── requirements.txt           # flask, bleak
│   ├── .env                       # Deployment-level env vars only (host, port, DB URL)
│   └── run.py                     # Entrypoint (Flask dev server, port 5000)
└── README.md
```

## Running the Server

```bash
cd server
sudo venv/bin/python run.py
```

Requires a Bluetooth adapter and either `sudo` or `CAP_NET_RAW` capability on the Python binary.

The web UI is served at `http://localhost:5000`. There is no separate frontend server.

## Key Design Decisions

- **bleak** is used for BLE scanning (not scapy). Scapy's AsyncSniffer uses libpcap which doesn't support HCI interfaces on Linux.
- The scanner is synchronous (`get_bluetooth_devices`) wrapping an async bleak scan via `asyncio.run()`. Flask routes call it directly.
- Distance estimation uses the log-distance path-loss model: `10 ^ ((tx_power - rssi) / (10 * n))` with a default TX power of `-59 dBm` when not advertised.
- Environment profiles control the path-loss exponent `n`: `outdoor` (2.0), `indoor_open` (2.5), `indoor_mixed` (3.0, default), `indoor_dense` (3.5). Higher `n` means signal falls off faster, giving more realistic indoor estimates.
- RSSI is smoothed over a 5-reading window before computing distance and signal quality, to reduce single-reading noise.
- `address_type` is derived from the MAC address first byte (≥ 0xC0 → random).
- The frontend is served from Flask itself (`/`) so no CORS configuration is needed. `app.js` calls `/api/devices` and `/api/reset` via relative paths.
- Per-device RSSI and distance history is accumulated **server-side** in `_device_store` (a module-level dict in `scanner.py`) across scan cycles. History is returned as relative timestamps (`t=0` = most recent reading). Devices not seen in the current scan are returned as stale (`active: false`) with `last_seen_s` set.
- Movement classification (`_compute_speeds`, `_movement_status`) runs server-side and is returned as `movement_label` / `movement_cls` fields. The JS renders these directly without any business logic.
- `.env` contains **deployment-level config only** (Flask host/port, database URL). Algorithm constants (TX power defaults, path-loss exponents, history window sizes, speed thresholds) live as named constants in `scanner.py`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI (device dashboard) |
| GET | `/api/devices` | Scan and return nearby BLE devices |
| POST | `/api/reset` | Clear all stored device history |

Query params for `/api/devices`:
- `timeout` (float, default `5.0`) — scan duration in seconds
- `environment` (string, default `indoor_mixed`) — one of `outdoor`, `indoor_open`, `indoor_mixed`, `indoor_dense`
