# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Radar is a BLE (Bluetooth Low Energy) device scanner with a Flask REST API backend. It discovers nearby Bluetooth devices and returns rich metadata including distance estimates, signal quality, vendor identification, and device profiles.

## Repository Structure

```
Radar/
├── server/                        # Flask server — API + frontend
│   ├── app/
│   │   ├── __init__.py            # App factory (create_app); serves / via render_template
│   │   ├── api/
│   │   │   └── routes.py          # REST endpoints (/api/devices)
│   │   ├── bluetooth/
│   │   │   └── scanner.py         # BLE scanning via bleak
│   │   ├── static/
│   │   │   ├── css/styles.css     # All UI styles
│   │   │   └── scripts/app.js     # Frontend logic (polling, graphs, status)
│   │   └── templates/
│   │       └── index.html         # Main page template
│   ├── requirements.txt           # flask, bleak
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
- Distance estimation uses the log-distance path-loss model: `10 ^ ((tx_power - rssi) / (10 * n))` with `n=2.0` and a default TX power of `-59 dBm` when not advertised.
- `address_type` is derived from the MAC address first byte (≥ 0xC0 → random).
- The frontend is served from Flask itself (`/`) so no CORS configuration is needed. `app.js` calls `/api/devices` via a relative path.
- Per-device RSSI and distance history is accumulated in the browser across polls. Speed (m/s) is derived client-side from consecutive distance readings.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI (device dashboard) |
| GET | `/api/devices` | Scan and return nearby BLE devices |

Query param for `/api/devices`: `timeout` (float, default `5.0` seconds).
