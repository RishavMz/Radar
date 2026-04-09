// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS       = 10_000;  // ms between auto-scans
const COUNTDOWN_TICK_MS      = 500;     // ms between countdown label updates
const DEFAULT_SCAN_TIMEOUT_S = 5;       // fallback when input is empty/invalid

const MAX_HISTORY            = 30;      // max data points kept per device
const STATUS_WINDOW          = 4;       // recent speed samples used for status

// Speed thresholds (m/s) for status classification
const SPEED_STATIONARY       = 0.03;
const SPEED_FAST             = 0.15;

// Signal quality breakpoints (%)
const QUALITY_HIGH           = 60;
const QUALITY_MEDIUM         = 30;

// Fallback sentinels used when a field is null during sorting
const SORT_FALLBACK_RSSI     = -200;
const SORT_FALLBACK_DISTANCE = 9_999;

// Sparkline SVG geometry (viewBox units)
const SPARK_W                = 240;
const SPARK_H                = 52;
const SPARK_PAD_X            = 6;
const SPARK_PAD_Y            = 6;
const SPARK_STROKE_WIDTH     = 1.8;
const SPARK_DOT_RADIUS       = 3;
const SPARK_LABEL_PRECISION  = 10;  // values >= this use 1 decimal place, else 2

// Colours
const COLOR_RSSI             = '#58a6ff';
const COLOR_CLOSER           = '#3fb950';
const COLOR_AWAY             = '#f85149';
const COLOR_STABLE           = '#d29922';

// API
const API_DEVICES_PATH       = '/api/devices';

// Element IDs
const EL_STATUS_BAR          = 'statusBar';
const EL_STATUS_TEXT         = 'statusText';
const EL_COUNTDOWN           = 'countdown';
const EL_SCAN_BTN            = 'scanBtn';
const EL_AUTO_BTN            = 'autoToggleBtn';
const EL_TIMEOUT_INPUT       = 'timeout';
const EL_FILTER_INPUT        = 'filterInput';
const EL_SORT_SELECT         = 'sortSelect';
const EL_GRID                = 'grid';

// Button / UI labels
const LABEL_SCAN_IDLE        = 'Scan';
const LABEL_SCAN_BUSY        = 'Scanning\u2026';
const LABEL_AUTO_ON          = 'Auto: On';
const LABEL_AUTO_OFF         = 'Auto: Off';

// CSS classes
const CLASS_SCANNING         = 'scanning';
const CLASS_AUTO_ACTIVE      = 'active';

// ── State ─────────────────────────────────────────────────────────────────────

let allDevices = [];
let pollTimer = null;
let countdownTimer = null;
let nextPollAt = null;
let isScanning = false;

// address -> [{time, rssi, distance}]
const deviceHistory = new Map();

// ── History ───────────────────────────────────────────────────────────────────

function updateHistory(devices, scanTime) {
  for (const d of devices) {
    if (!deviceHistory.has(d.address)) deviceHistory.set(d.address, []);
    const hist = deviceHistory.get(d.address);
    hist.push({ time: scanTime, rssi: d.rssi, distance: d.estimated_distance_m });
    if (hist.length > MAX_HISTORY) hist.shift();
  }
}

// Returns speeds in m/s (positive = moving away, negative = getting closer).
// One entry per consecutive pair; null when distance unavailable.
function computeSpeeds(history) {
  const speeds = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    if (prev.distance == null || curr.distance == null) { speeds.push(null); continue; }
    const dt = (curr.time - prev.time) / 1000;
    speeds.push(dt > 0 ? (curr.distance - prev.distance) / dt : null);
  }
  return speeds;
}

function deviceStatus(speeds) {
  const valid = speeds.filter(s => s != null);
  if (valid.length === 0) return { label: 'Tracking…', cls: 'tracking' };

  const recent = valid.slice(-STATUS_WINDOW);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const absAvg = Math.abs(avg);

  if (absAvg < SPEED_STATIONARY) return { label: 'Stationary',      cls: 'stable'  };
  if (avg < -SPEED_FAST)         return { label: 'Approaching fast', cls: 'closer'  };
  if (avg < 0)                   return { label: 'Getting closer',   cls: 'closer'  };
  if (avg > SPEED_FAST)          return { label: 'Moving away fast', cls: 'away'    };
  return                                { label: 'Moving away',      cls: 'away'    };
}

// ── SVG Sparkline ─────────────────────────────────────────────────────────────

function sparkline(values, { color = '#58a6ff', zeroLine = false } = {}) {
  const valid = values.filter(v => v != null);
  if (valid.length < 2) {
    return `<div class="spark-empty">Not enough data yet</div>`;
  }

  const minY = Math.min(...valid);
  const maxY = Math.max(...valid);
  const range = maxY - minY || 1;
  const innerW = SPARK_W - SPARK_PAD_X * 2;
  const innerH = SPARK_H - SPARK_PAD_Y * 2;

  // Use index as x so gaps in nulls still render connected valid segments
  const pts = [];
  values.forEach((v, i) => {
    if (v == null) return;
    const x = SPARK_PAD_X + (i / (values.length - 1)) * innerW;
    const y = SPARK_H - SPARK_PAD_Y - ((v - minY) / range) * innerH;
    pts.push([x, y]);
  });

  const polyline = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  let zeroEl = '';
  if (zeroLine && minY < 0 && maxY > 0) {
    const zy = SPARK_H - SPARK_PAD_Y - ((0 - minY) / range) * innerH;
    zeroEl = `<line x1="${SPARK_PAD_X}" y1="${zy.toFixed(1)}" x2="${SPARK_W - SPARK_PAD_X}" y2="${zy.toFixed(1)}"
      stroke="#30363d" stroke-width="1" stroke-dasharray="3,3"/>`;
  }

  const fmtY = v => Math.abs(v) < SPARK_LABEL_PRECISION ? v.toFixed(2) : v.toFixed(1);

  return `
  <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" class="sparkline-svg">
    ${zeroEl}
    <path d="${polyline}" fill="none" stroke="${color}" stroke-width="${SPARK_STROKE_WIDTH}"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="${SPARK_DOT_RADIUS}" fill="${color}"/>
    <text x="${SPARK_PAD_X}" y="${SPARK_PAD_Y + 1}" class="spark-label" dominant-baseline="hanging">${fmtY(maxY)}</text>
    <text x="${SPARK_PAD_X}" y="${SPARK_H - SPARK_PAD_Y}" class="spark-label" dominant-baseline="auto">${fmtY(minY)}</text>
  </svg>`;
}

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(cls, text) {
  const bar = document.getElementById(EL_STATUS_BAR);
  bar.className = cls;
  document.getElementById(EL_STATUS_TEXT).textContent = text;
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function startCountdown() {
  stopCountdown();
  nextPollAt = Date.now() + POLL_INTERVAL_MS;
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
    document.getElementById(EL_COUNTDOWN).textContent =
      remaining > 0 ? `Next scan in ${remaining}s` : '';
  }, COUNTDOWN_TICK_MS);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  document.getElementById(EL_COUNTDOWN).textContent = '';
}

// ── Scan ──────────────────────────────────────────────────────────────────────

async function startScan() {
  if (isScanning) return;
  isScanning = true;

  const btn     = document.getElementById(EL_SCAN_BTN);
  const timeout = parseFloat(document.getElementById(EL_TIMEOUT_INPUT).value) || DEFAULT_SCAN_TIMEOUT_S;

  btn.disabled = true;
  btn.classList.add(CLASS_SCANNING);
  btn.textContent = LABEL_SCAN_BUSY;
  stopCountdown();
  setStatus('busy', `Scanning for ${timeout}s — please wait…`);

  try {
    const res = await fetch(`${API_DEVICES_PATH}?timeout=${timeout}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    allDevices = data.devices || [];
    updateHistory(allDevices, Date.now());
    const now = new Date().toLocaleTimeString();
    setStatus('ok', `Found ${data.count} device${data.count !== 1 ? 's' : ''} — last updated ${now}`);
    renderCards();
  } catch (e) {
    setStatus('err', `Error: ${e.message}`);
  } finally {
    isScanning = false;
    btn.disabled = false;
    btn.classList.remove(CLASS_SCANNING);
    btn.textContent = LABEL_SCAN_IDLE;
    if (pollTimer !== null) startCountdown();
  }
}

// ── Auto-poll ─────────────────────────────────────────────────────────────────

function toggleAutoPoll() {
  const btn = document.getElementById(EL_AUTO_BTN);
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
    stopCountdown();
    btn.classList.remove(CLASS_AUTO_ACTIVE);
    btn.textContent = LABEL_AUTO_OFF;
  } else {
    startScan();
    pollTimer = setInterval(startScan, POLL_INTERVAL_MS);
    btn.classList.add(CLASS_AUTO_ACTIVE);
    btn.textContent = LABEL_AUTO_ON;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderCards() {
  const filter = document.getElementById(EL_FILTER_INPUT).value.toLowerCase();
  const sort   = document.getElementById(EL_SORT_SELECT).value;
  const grid   = document.getElementById(EL_GRID);

  let devices = allDevices.filter(d => {
    if (!filter) return true;
    return (
      (d.name    || '').toLowerCase().includes(filter) ||
      (d.address || '').toLowerCase().includes(filter) ||
      (d.known_companies || []).some(c => c.toLowerCase().includes(filter)) ||
      (d.device_profiles || []).some(p => p.toLowerCase().includes(filter))
    );
  });

  devices = [...devices].sort((a, b) => {
    switch (sort) {
      case 'rssi':     return (b.rssi ?? SORT_FALLBACK_RSSI) - (a.rssi ?? SORT_FALLBACK_RSSI);
      case 'distance': return (a.estimated_distance_m ?? SORT_FALLBACK_DISTANCE) - (b.estimated_distance_m ?? SORT_FALLBACK_DISTANCE);
      case 'name':     return (a.name || 'zz').localeCompare(b.name || 'zz');
      case 'quality':  return (b.signal_quality_pct ?? 0) - (a.signal_quality_pct ?? 0);
      default:         return 0;
    }
  });

  if (devices.length === 0 && allDevices.length === 0) {
    grid.innerHTML = `<div id="placeholder"><div class="big">&#x1F4E1;</div>Hit <strong>Scan</strong> to discover nearby BLE devices.</div>`;
    return;
  }
  if (devices.length === 0) {
    grid.innerHTML = `<div id="placeholder"><div class="big">&#x1F50D;</div>No devices match your filter.</div>`;
    return;
  }

  grid.innerHTML = devices.map(cardHTML).join('');
}

// ── Card ──────────────────────────────────────────────────────────────────────

function qualityClass(pct) {
  if (pct >= QUALITY_HIGH)   return 'high';
  if (pct >= QUALITY_MEDIUM) return 'medium';
  return 'low';
}

function cardHTML(d) {
  const pct = d.signal_quality_pct ?? 0;
  const cls = qualityClass(pct);

  const vendorBadges = (d.known_companies || []).map(c => {
    const vcls = c === 'Apple' ? 'apple' : c === 'Microsoft' ? 'ms' : 'vendor';
    return `<span class="badge badge-${vcls}">${escHtml(c)}</span>`;
  }).join('');

  const profileBadges = (d.device_profiles || [])
    .map(p => `<span class="badge badge-profile">${escHtml(p)}</span>`)
    .join('');

  const addrBadge  = `<span class="badge badge-${d.address_type}">${d.address_type}</span>`;
  const distTxt    = d.estimated_distance_m != null ? `~${d.estimated_distance_m} m` : 'n/a';
  const txTxt      = d.tx_power    != null ? `${d.tx_power} dBm`    : 'n/a';
  const plTxt      = d.path_loss_db != null ? `${d.path_loss_db} dB` : 'n/a';
  const tagSection = (vendorBadges || profileBadges)
    ? `<div class="tags">${vendorBadges}${profileBadges}</div>` : '';

  // History-based graphs and status
  const hist   = deviceHistory.get(d.address) || [];
  const speeds = computeSpeeds(hist);
  const status = deviceStatus(speeds);

  const rssiValues  = hist.map(h => h.rssi);
  const speedValues = speeds; // may contain nulls

  const rssiColor  = COLOR_RSSI;
  const speedColor = status.cls === 'closer' ? COLOR_CLOSER
                   : status.cls === 'away'   ? COLOR_AWAY
                   : COLOR_STABLE;

  const rssiGraph  = sparkline(rssiValues,  { color: rssiColor });
  const speedGraph = sparkline(speedValues, { color: speedColor, zeroLine: true });

  return `
  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-name">${escHtml(d.name)}</div>
        <div class="card-addr">${escHtml(d.address)}</div>
      </div>
      ${addrBadge}
    </div>

    <div class="signal-row">
      <span class="signal-label">Signal</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="signal-val">${d.rssi} dBm</span>
    </div>

    <div class="signal-row">
      <span class="signal-label">Quality</span>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="signal-val">${pct}%</span>
    </div>

    <div class="meta">
      <span class="meta-key">Distance</span><span class="meta-val">${distTxt}</span>
      <span class="meta-key">TX Power</span><span class="meta-val">${txTxt}</span>
      <span class="meta-key">Path Loss</span><span class="meta-val">${plTxt}</span>
    </div>

    ${tagSection}

    <div class="graphs">
      <div class="graph-block">
        <div class="graph-title">RSSI history <span class="graph-unit">(dBm)</span></div>
        ${rssiGraph}
      </div>
      <div class="graph-block">
        <div class="graph-title">Speed <span class="graph-unit">(m/s, + = away)</span></div>
        ${speedGraph}
      </div>
    </div>

    <div class="device-status status-${status.cls}">${status.label}</div>
  </div>`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
