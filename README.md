# Radar

BLE device scanner with a Flask REST API. A background job continuously scans for nearby Bluetooth devices, persists readings to SQLite, and purges data older than 2 minutes. The API returns one entry per distinct device, enriched with motion analysis derived from the full scan history.

## Setup

**Prerequisites:** Python 3.12+, Linux with BlueZ, Bluetooth adapter.

```bash
cd server
python -m venv venv
pip install -r requirements.txt
cp .env.example .env        # edit as needed
FLASK_APP=run.py venv/bin/flask db upgrade
sudo venv/bin/python run.py
```

Or avoid `sudo` permanently:
```bash
sudo setcap cap_net_raw,cap_net_admin+eip venv/bin/python3.12
venv/bin/python run.py
```

## Configuration

All constants live in `server/.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `FLASK_ENV` | `development` | `development` or `production` |
| `FLASK_HOST` | `0.0.0.0` | Bind address |
| `FLASK_PORT` | `5000` | Port |
| `DATABASE_URL` | `sqlite:///radar.db` | SQLAlchemy DB URL |
| `BLE_SCAN_TIMEOUT` | `10.0` | Seconds per scan pass |
| `BLE_SCAN_INTERVAL_SECONDS` | `15` | Seconds between scan jobs |
| `BLE_RETENTION_SECONDS` | `120` | Data retention window |
| `PURGE_INTERVAL_SECONDS` | `30` | How often the purge job runs |
| `BLE_DEFAULT_TX_POWER` | `-59` | Fallback TX power (dBm) |
| `BLE_PATH_LOSS_N` | `2.0` | Path-loss exponent |

## API

### `GET /api/devices`

Returns one entry per distinct device seen within the last 2 minutes.

```bash
curl http://localhost:5000/api/devices
```

```json
{
  "count": 1,
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
      "last_seen": "2026-04-09T10:00:00+00:00",
      "analysis": {
        "smoothed_distance_m": 3.21,
        "speed_m_s": 0.04,
        "trend": "stationary",
        "datapoints": [
          {
            "timestamp": "2026-04-09T09:59:00+00:00",
            "rssi": -68,
            "raw_distance_m": 3.98,
            "smoothed_distance_m": 3.45
          },
          {
            "timestamp": "2026-04-09T10:00:00+00:00",
            "rssi": -65,
            "raw_distance_m": 3.16,
            "smoothed_distance_m": 3.21
          }
        ]
      }
    }
  ]
}
```

**`analysis` fields:**

| Field | Description |
|---|---|
| `smoothed_distance_m` | Kalman-filtered distance of the latest scan (metres) |
| `speed_m_s` | Median speed across scan pairs (m/s) |
| `trend` | `approaching` / `receding` / `stationary` |
| `datapoints` | Array of per-scan records: `timestamp`, `rssi`, `raw_distance_m`, `smoothed_distance_m` |

## Motion Analysis Algorithm

Raw RSSI is highly noisy (multipath, reflections, device orientation). The pipeline:

### 1. Kalman Filter (RSSI smoothing)

A 1D Kalman filter models RSSI as a slowly drifting state corrupted by measurement noise:

```
# Predict
p_pred = p + Q

# Update
K      = p_pred / (p_pred + R)     ← Kalman gain
x      = x + K × (z − x)           ← fuse measurement z into estimate x
p      = (1 − K) × p_pred
```

- **Q = 2.0 dBm²** — process noise: how much true RSSI drifts between scans  
- **R = 9.0 dBm²** — measurement noise: ±3 dBm sensor uncertainty  

The Kalman gain K auto-balances trust between the model and the measurement. High K → trust the measurement; low K → trust the prior estimate.

### 2. Distance (log-distance path-loss model)

```
d = 10 ^ ((TX_power − RSSI_smoothed) / (10 × n))
```

- `TX_power`: advertised by device, or `BLE_DEFAULT_TX_POWER` (-59 dBm)  
- `n`: `BLE_PATH_LOSS_N` (2.0 = free space; 2–3 typical indoors)

### 3. Speed (median of Δd/Δt)

Speed is computed between every consecutive scan pair and the **median** is taken:

```
speeds = [ |d[i] − d[i−1]| / (t[i] − t[i−1])  for each consecutive pair ]
speed  = median(speeds)
```

Median is used over mean because a single outlier scan (e.g. the device briefly turning) would skew an average but cannot affect the median.

### 4. Trend (linear regression slope)

OLS slope of smoothed distances over timestamps across all datapoints:

```
slope = Σ (tᵢ − t̄)(dᵢ − d̄) / Σ (tᵢ − t̄)²
```

- `slope > 0.05 m/s` → **receding**  
- `slope < −0.05 m/s` → **approaching**  
- otherwise → **stationary**

Using the full history via regression is more stable than comparing window halves, since it uses all available evidence and naturally handles uneven scan intervals.
