# Radar — Algorithm & Data Processing Reference

This document describes the signal processing, distance estimation, movement classification, and data storage strategies used in Radar. It is intended for contributors who need to understand or modify the core logic, not for setup or API usage (see README.md for that).

---

## 1. Signal Acquisition

### Bluetooth (BLE)
Uses the `bleak` library's callback-based async scanner. Within a scan window of `timeout` seconds, every advertised BLE packet fires a callback. Each device is de-duplicated per window (first packet wins). The callback captures:
- Raw RSSI (dBm) directly from the advertisement
- TX Power (dBm) if the device advertises it — used as the reference RSSI at 1 m
- Manufacturer data, service UUIDs, address type

Scanning runs inside `asyncio.run()`, wrapping the async scan into a synchronous call.

### WiFi
Uses `nmcli --terse --fields BSSID,SSID,SIGNAL,FREQ,SECURITY,CHAN dev wifi list --rescan yes` via subprocess. Key notes:
- nmcli reports signal as an integer **quality score (0–100)**, not dBm
- Colons inside BSSID values are escaped as `\:` in terse output and must be unescaped
- The quality-to-dBm conversion is:

```
rssi_dbm = (quality // 2) - 100
```

This maps quality 0 → −100 dBm, quality 100 → −50 dBm. The integer division means only **51 distinct dBm values** are possible — an inherent quantization floor on WiFi distance precision.

---

## 2. Distance Estimation

### Model
The **log-distance path-loss model** is used for both protocols:

```
distance (m) = 10 ^ ((ref_rssi - rssi) / (10 × n))
```

| Symbol | Meaning |
|--------|---------|
| `rssi` | Smoothed received signal strength (dBm) |
| `ref_rssi` | Expected RSSI at exactly 1 metre (dBm) |
| `n` | Path-loss exponent — how fast signal decays with distance |

**Source:** `core/distance.py:DistanceEstimator.estimate()`

### Path-loss Exponent `n` by Environment

| Profile | `n` | Use case |
|---------|-----|----------|
| `outdoor` | 2.0 | Free space (theoretical) |
| `indoor_open` | 2.5 | Open office, warehouse |
| `indoor_mixed` | 3.0 | Typical office with walls (default) |
| `indoor_dense` | 3.5 | Dense walls, furniture, interference |

Higher `n` → faster signal decay → shorter estimated distances for the same RSSI.

### Reference RSSI

**BLE:** Uses the device's advertised TX Power as `ref_rssi`. If the device does not advertise TX power, defaults to `−59 dBm` (a common empirical value for consumer BLE devices at 1 m).

**WiFi:** Reference RSSI is frequency-dependent because free-space path loss increases with frequency. A 5 GHz signal loses ~5 dB more than a 2.4 GHz signal over the same 1 m:

| Band | Frequency | `ref_rssi` |
|------|-----------|-----------|
| 2.4 GHz | < 5000 MHz | −40 dBm |
| 5 GHz | 5000–5999 MHz | −45 dBm |
| 6 GHz | ≥ 6000 MHz | −48 dBm |

**Source:** `wifi/metadata.py:ref_rssi_for_freq()`

### Known Limitations
- The path-loss model assumes a single dominant propagation path. Real indoor environments have multipath reflections and absorption that can cause 5–15 dBm variance in RSSI even at a fixed position.
- BLE TX power is self-reported by the device and may be inaccurate.
- WiFi quality quantization means distances are effectively bucketed — a quality score of 60 and 61 map to the same −70 dBm.
- The model cannot distinguish a device behind a wall from one in open space at the same distance.

---

## 3. RSSI Smoothing (EWMA + Outlier Gate)

Raw RSSI is noisy. A single-sample reading can vary ±10 dBm from the true mean at a fixed position. Smoothing is applied before distance computation.

### Exponential Weighted Moving Average (EWMA)

```
smoothed_rssi(t) = α × raw_rssi(t) + (1 − α) × smoothed_rssi(t−1)
```

**α = 0.3** (weight of the newest sample). This gives an effective time constant of ~3 scan intervals — recent readings matter more but the running estimate is stable.

**Bootstrap:** On the very first reading for a device, `smoothed_rssi = raw_rssi` (no prior state).

**Why EWMA over a simple moving average:**
- SMA weights all samples equally; a burst of bad readings `n` scans ago still pollutes the estimate until they age out
- EWMA decays past influence exponentially — old readings become negligible naturally
- Stateful: requires only the previous EWMA value, not the full window

**Source:** `core/scanner.py:BaseScanner._compute_ewma_rssi()`

### Outlier Gate

Before updating the EWMA, each new raw RSSI is tested against the recent history:

```
recent = last 10 raw RSSI readings
if len(recent) >= 4:
    mean = avg(recent)
    std  = population_std(recent)
    if std > 0 and |raw_rssi - mean| > 2.0 × std:
        → OUTLIER: keep previous EWMA unchanged, mark row as is_outlier=True
```

**Why:** A single rogue reading (e.g., −20 dBm spike from interference) would otherwise pull the EWMA sharply. The 2σ gate rejects readings that are statistically implausible given recent history, without knowing anything about the physical environment.

**Edge cases:**
- Fewer than 4 samples: gate is disabled (insufficient baseline for reliable std)
- Std = 0 (all identical readings): gate is disabled (no meaningful deviation to measure)
- Outlier with no prior EWMA: bootstraps from raw RSSI anyway (cannot hold `None`)

### State Persistence
`smoothed_rssi` is stored in the history table (`bluetooth_history.smoothed_rssi`, `wifi_history.smoothed_rssi`). On restart, `_init_store()` seeds the in-memory store from DB rows, so `get_smoothed_rssi()` returns the last known EWMA value and the filter resumes without a cold-start discontinuity.

---

## 4. Signal Quality Score

Reported as `signal_quality_pct` (0–100%) in API responses. Derived from smoothed RSSI:

```
clamped = clamp(smoothed_rssi, −100.0, −30.0)
quality = (clamped + 100) / 70 × 100
```

Maps −100 dBm → 0%, −30 dBm → 100%. Values outside this range are clamped. The denominator (70) spans the practical indoor RSSI range.

**Source:** `core/distance.py:DistanceEstimator.signal_quality()`

---

## 5. Movement Classification

### Speed Computation

Per-interval speed is derived from consecutive smoothed distance readings in history:

```
speed(i) = (smoothed_distance(i) − smoothed_distance(i−1)) / (time(i) − time(i−1))   [m/s]
```

- Positive speed → device moving away
- Negative speed → device approaching
- `None` emitted for intervals where either distance is missing (outlier-gated reading, device not seen)

Crucially, **smoothed distances** (from EWMA RSSI) are used here, not raw distances. Differentiating raw RSSI-derived distances amplifies noise by ~10× because the derivative of a noisy signal is far noisier than the signal itself.

**Source:** `core/movement.py:MovementClassifier.compute_speeds()`

### Speed EWMA

Before classification, the latest valid speed is smoothed:

```
smoothed_speed(t) = β × speed(t) + (1 − β) × smoothed_speed(t−1)
```

**β = 0.4** — more responsive than the RSSI EWMA (β > α) because speed needs to track direction reversals quickly while RSSI changes are slower.

**Bootstrap:** First valid speed reading sets `smoothed_speed = speed`.

### Hysteresis

The last `STATUS_WINDOW = 4` valid speed samples are each independently classified:

```
|speed| < speed_stationary  →  "stable"
speed < 0                   →  "closer"
speed > 0                   →  "away"
```

Then a vote is taken:

```
dominant_state = most frequent state among the 4 samples
if count(dominant_state) >= HYSTERESIS_CONFIRM (3):
    accept state transition
else:
    hold previous state
```

**Why hysteresis:** Without it, a device hovering near a threshold (e.g., barely stationary) alternates between states on every scan. Requiring 3/4 agreement means at least 3 consecutive samples must agree before a label changes — eliminating flicker from isolated noisy readings.

### Speed Thresholds

| Protocol | Stationary threshold | Fast threshold |
|----------|---------------------|----------------|
| BLE | 0.03 m/s | 0.15 m/s |
| WiFi | 0.05 m/s | 0.20 m/s |

WiFi thresholds are higher because `quality_to_dbm` quantization introduces artificial distance jumps between scans even when the AP is stationary.

### Output Labels

| `movement_cls` | `movement_label` | Condition |
|----------------|-----------------|-----------|
| `stable` | Stationary | `\|smoothed_speed\| < speed_stationary` |
| `closer` | Getting closer | `smoothed_speed < 0, \|speed\| ≤ speed_fast` |
| `closer` | Approaching fast | `smoothed_speed < 0, \|speed\| > speed_fast` |
| `away` | Moving away | `smoothed_speed > 0, speed ≤ speed_fast` |
| `away` | Moving away fast | `smoothed_speed > 0, speed > speed_fast` |
| `tracking` | Tracking… | No valid speed samples yet |

### State Persistence
`smoothed_speed`, `movement_state`, and `movement_since` are persisted on device rows (`bluetooth_devices`, `wifi_devices`). On restart, `_init_store()` seeds these into the in-memory store so the EWMA and hysteresis state resume without a cold start.

**Source:** `core/movement.py:MovementClassifier.classify()`

---

## 6. Data Storage

### In-Memory Store (`DeviceStore`)

Each protocol scanner owns one `DeviceStore` instance. It is a `dict[key → entry]` where `key` is MAC address (BLE) or BSSID (WiFi). Each entry holds:

```
{
  "snapshot":       dict   — latest device metadata
  "history":        list   — up to MAX_HISTORY entries, oldest first:
                               {time, rssi, distance,
                                smoothed_rssi, smoothed_distance, is_outlier}
  "last_seen":      float  — Unix timestamp of last reading
  "smoothed_speed": float  — last EWMA speed value (m/s)
  "movement_state": str    — last confirmed state
  "movement_since": float  — Unix timestamp of last state transition
}
```

**MAX_HISTORY = 60** entries per device. At a 10-second scan interval this covers ~10 minutes of history. Older entries are evicted (FIFO) from the in-memory list.

The store is populated lazily on the **first scan** from the DB (`_init_store()`), then kept in sync with every new reading. It is the authoritative source during a running session — the DB is a persistence backing store, not the runtime source of truth.

### SQLite Schema

```
bluetooth_devices / wifi_devices   (one row per device, updated each scan)
  ├── address / bssid              PRIMARY KEY
  ├── [protocol-specific metadata columns]
  ├── last_seen_at                 Unix timestamp
  ├── created_at                   Unix timestamp
  ├── smoothed_speed               EWMA speed seed — restored on restart
  ├── movement_state               Hysteresis state seed — restored on restart
  └── movement_since               Timestamp of last transition

bluetooth_history / wifi_history   (time-series, max 60 rows per device)
  ├── id                           AUTOINCREMENT PK
  ├── address / bssid              FK → device, CASCADE DELETE
  ├── rssi                         Raw RSSI at scan time (integer dBm)
  ├── distance                     Raw distance from raw RSSI (metres)
  ├── smoothed_rssi                EWMA RSSI at this point in time
  ├── is_outlier                   True if this reading was gated out
  └── recorded_at                  Unix timestamp
```

**Why both raw and smoothed values are stored:**
- `rssi` + `distance`: raw values preserved for debugging, auditing, and potential reprocessing with different parameters
- `smoothed_rssi`: the EWMA running state — needed so the filter can resume correctly after a restart without replaying all history

**History trimming:** After each `flush()`, a subquery deletes all rows for that device beyond the 60 most recent, ordered by `recorded_at DESC`. This runs inside the same transaction as the insert.

### Schema Migrations

`db.create_all()` handles new databases. For existing databases, `models/migrations.py:migrate_db(engine)` runs at startup and applies any missing columns via `ALTER TABLE`, guarded by `PRAGMA table_info` checks. Fully idempotent.

---

## 7. Scan Flow (Two-Phase Commit)

Each call to `get_devices()` performs two database commits:

```
Phase 1 — Scan data
  for each reading from _do_scan():
    1. Get prev EWMA from store (get_smoothed_rssi)
    2. Compute new smoothed_rssi + is_outlier  (_compute_ewma_rssi)
    3. Compute smoothed_distance               (DistanceEstimator.estimate)
    4. Update in-memory store                  (DeviceStore.update)
    5. Stage ORM upsert + history insert       (_persist_reading)
  → db.session.commit()   [all scan data in one transaction]

Phase 2 — Movement state
  _build_results():
    for each store entry:
      1. Build hist_for_movement using smoothed_distance (fallback raw)
      2. Compute speed series                 (MovementClassifier.compute_speeds)
      3. Apply speed EWMA + hysteresis        (MovementClassifier.classify)
      4. Write smoothed_speed / state / since back to store entry
  for each store entry:
    5. Stage UPDATE on device row             (_persist_movement_state)
  → db.session.commit()   [all movement state in one transaction]
```

**Why two commits:** Movement state is derived in `_build_results()` which runs after the scan data commit. Merging both into one transaction would require computing movement inside the scan loop (before all readings for the window are processed) — breaking the clean separation between data ingestion and result assembly.

Both commits use try/except with rollback on failure. The in-memory store is always updated regardless of DB failures, so the session remains operational even if SQLite is temporarily unavailable.

---

## 8. Angular Position (Dashboard)

Devices on the radar chart need a stable angle. No bearing hardware is available, so a **deterministic pseudo-angle** is derived from the device ID:

```
angle_deg = int(MD5(device_id)[:8], 16) % 360
```

Properties:
- **Deterministic:** same device always gets the same angle across polls and restarts
- **Uniform distribution:** MD5 hex digits distribute angles roughly evenly around the circle
- **Stable:** angle does not change as RSSI or distance changes — only radial position moves

This is explicitly not a bearing. True directional information requires multi-antenna AoA/AoD hardware. The pseudo-angle exists purely to spread devices visually so they don't pile up on a single radial line.

**Radar radial scale:** Logarithmic to prevent close devices from crowding the centre:

```
radial_position = log(distance + 1) / log(MAX_RANGE + 1) × R
```

Selectable `MAX_RANGE`: 15, 30, 50, 75, 100 m.

---

## 9. Concurrency (Sonar Endpoint)

`/api/sonar/snapshot` runs BLE and WiFi scans concurrently:

```python
ThreadPoolExecutor(max_workers=2)
  ├── thread 1: BluetoothScanner.get_devices()  [with app context pushed]
  └── thread 2: WifiScanner.get_devices()        [with app context pushed]
```

Each thread pushes its own Flask application context (`app.app_context()`) because SQLAlchemy's session is thread-local. The two scanners own separate `DeviceStore` and `db.session` instances so there is no shared mutable state between threads.

---

## 10. Constant Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `EWMA_ALPHA` | 0.3 | `core/scanner.py` | RSSI smoothing weight |
| `OUTLIER_WINDOW` | 10 | `core/scanner.py` | Readings used for outlier mean/std |
| `OUTLIER_SIGMA` | 2.0 | `core/scanner.py` | Outlier rejection threshold (σ) |
| `SPEED_EWMA_BETA` | 0.4 | `core/movement.py` | Speed smoothing weight |
| `HYSTERESIS_CONFIRM` | 3 | `core/movement.py` | Min votes to confirm state change |
| `STATUS_WINDOW` | 4 | `core/movement.py` | Speed samples considered per classification |
| `MAX_HISTORY` | 60 | `core/store.py` | Max history rows per device (memory + DB) |
| BLE default TX power | −59 dBm | `bluetooth/scanner.py` | Fallback ref RSSI when not advertised |
| BLE `speed_stationary` | 0.03 m/s | `bluetooth/scanner.py` | Stationary threshold |
| BLE `speed_fast` | 0.15 m/s | `bluetooth/scanner.py` | Fast movement threshold |
| WiFi `speed_stationary` | 0.05 m/s | `wifi/scanner.py` | Higher due to nmcli quantization noise |
| WiFi `speed_fast` | 0.20 m/s | `wifi/scanner.py` | Higher due to nmcli quantization noise |
