# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Radar is a BLE (Bluetooth Low Energy) device scanner with a Flask REST API backend. It discovers nearby Bluetooth devices and returns rich metadata including distance estimates, signal quality, vendor identification, and device profiles.

## Repository Structure

```
Radar/
├── server/                   # Flask API server (Python)
│   ├── app/
│   │   ├── __init__.py       # App factory (create_app)
│   │   ├── api/
│   │   │   └── routes.py     # REST endpoints (/api/devices)
│   │   └── bluetooth/
│   │       └── scanner.py    # BLE scanning via bleak
│   ├── requirements.txt      # flask, bleak
│   └── run.py                # Entrypoint (Flask dev server, port 5000)
└── README.md
```

## Running the Server

```bash
cd server
sudo venv/bin/python run.py
```

Requires a Bluetooth adapter and either `sudo` or `CAP_NET_RAW` capability on the Python binary.

## Key Design Decisions

- **bleak** is used for BLE scanning (not scapy). Scapy's AsyncSniffer uses libpcap which doesn't support HCI interfaces on Linux.
- The scanner is synchronous (`get_bluetooth_devices`) wrapping an async bleak scan via `asyncio.run()`. Flask routes call it directly.
- Distance estimation uses the log-distance path-loss model: `10 ^ ((tx_power - rssi) / (10 * n))` with `n=2.0` and a default TX power of `-59 dBm` when not advertised.
- `address_type` is derived from the MAC address first byte (≥ 0xC0 → random).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/devices` | Scan and return nearby BLE devices |

Query param: `timeout` (float, default `5.0` seconds).
