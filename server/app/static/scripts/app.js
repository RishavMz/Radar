// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS       = 10_000;  // ms between auto-scans
const COUNTDOWN_TICK_MS      = 500;     // ms between countdown label updates
const DEFAULT_SCAN_TIMEOUT_S = 5;       // fallback when input is empty/invalid

// Signal quality breakpoints (%) — used only for bar CSS class
const QUALITY_HIGH           = 60;
const QUALITY_MEDIUM         = 30;

// Fallback sentinels used when a field is null during sorting
const SORT_FALLBACK_RSSI     = -200;
const SORT_FALLBACK_DISTANCE = 9_999;

// Graph SVG geometry (viewBox units)
const GRAPH_W           = 260;
const GRAPH_H           = 80;
const GRAPH_PT          = 8;    // top padding
const GRAPH_PB          = 16;   // bottom padding (time axis labels)
const GRAPH_PL          = 30;   // left padding (y-axis labels)
const GRAPH_PR          = 6;    // right padding
const GRAPH_STROKE_W    = 1.8;
const GRAPH_DOT_R       = 3;    // most-recent point dot radius
const GRAPH_DOT_R_SMALL = 1.5;  // intermediate point dot radius

// Colours
const COLOR_RSSI        = '#58a6ff';
const COLOR_CLOSER      = '#3fb950';
const COLOR_AWAY        = '#f85149';
const COLOR_STABLE      = '#d29922';

// API
const API_DEVICES_PATH  = '/api/devices';
const API_RESET_PATH    = '/api/reset';

// Element IDs
const EL_STATUS_BAR     = 'statusBar';
const EL_STATUS_TEXT    = 'statusText';
const EL_COUNTDOWN      = 'countdown';
const EL_SCAN_BTN       = 'scanBtn';
const EL_AUTO_BTN       = 'autoToggleBtn';
const EL_ENV_SELECT     = 'envSelect';
const EL_TIMEOUT_INPUT  = 'timeout';
const EL_FILTER_INPUT   = 'filterInput';
const EL_SORT_SELECT    = 'sortSelect';
const EL_GRID           = 'grid';
const EL_CLEAR_BTN      = 'clearBtn';

// Button / UI labels
const LABEL_SCAN_IDLE   = 'Scan';
const LABEL_SCAN_BUSY   = 'Scanning\u2026';
const LABEL_AUTO_ON     = 'Auto: On';
const LABEL_AUTO_OFF    = 'Auto: Off';

// CSS classes
const CLASS_SCANNING    = 'scanning';
const CLASS_AUTO_ACTIVE = 'active';

// ── State ─────────────────────────────────────────────────────────────────────

let allDevices = [];
let pollTimer = null;
let countdownTimer = null;
let nextPollAt = null;
let isScanning = false;

// ── Status bar ────────────────────────────────────────────────────────────────

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
  const env     = document.getElementById(EL_ENV_SELECT).value;

  btn.disabled = true;
  btn.classList.add(CLASS_SCANNING);
  btn.textContent = LABEL_SCAN_BUSY;
  stopCountdown();
  setStatus('busy', `Scanning for ${timeout}s — please wait…`);

  try {
    const res = await fetch(`${API_DEVICES_PATH}?timeout=${timeout}&environment=${env}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    allDevices = data.devices || [];
    const active = allDevices.filter(d => d.active).length;
    const now = new Date().toLocaleTimeString();
    setStatus('ok', `${active} active, ${allDevices.length - active} stale — last updated ${now}`);
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

// ── Clear data ────────────────────────────────────────────────────────────────

async function clearData() {
  await fetch(API_RESET_PATH, { method: 'POST' });
  allDevices = [];
  renderCards();
  setStatus('', 'Data cleared \u2014 press Scan to start fresh.');
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

// ── Graph ─────────────────────────────────────────────────────────────────────

// Format a relative time offset (negative seconds) for axis labels.
function fmtRelTime(t) {
  if (Math.abs(t) < 1) return 'now';
  const s = Math.abs(Math.round(t));
  if (s < 60) return `-${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `-${m}m${rem}s` : `-${m}m`;
}

// Format a y-axis value label.
function fmtVal(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

// Draw a time-series graph for one field ('rssi' or 'distance') from history.
// history: [{t, rssi, distance}, ...] where t=0 is the most recent reading.
// gradId: unique SVG gradient id string.
function drawGraph(history, field, { color, gradId }) {
  const pts = history.map(h => ({ t: h.t, v: h[field] })).filter(p => p.v != null);

  if (pts.length < 2) {
    return `<div class="graph-empty">Not enough data yet</div>`;
  }

  const tMin = pts[0].t;
  const tMax = pts[pts.length - 1].t;
  const vMin = Math.min(...pts.map(p => p.v));
  const vMax = Math.max(...pts.map(p => p.v));
  const tRange = tMax - tMin || 1;
  const vRange = vMax - vMin || 1;

  // Plot area boundaries
  const px1 = GRAPH_PL, px2 = GRAPH_W - GRAPH_PR;
  const py1 = GRAPH_PT, py2 = GRAPH_H - GRAPH_PB;
  const pw  = px2 - px1;
  const ph  = py2 - py1;

  const toX = t => px1 + ((t - tMin) / tRange) * pw;
  const toY = v => py2 - ((v - vMin) / vRange) * ph;

  const coords = pts.map(p => [toX(p.t), toY(p.v)]);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords.at(-1)[0].toFixed(1)},${py2} L${coords[0][0].toFixed(1)},${py2} Z`;

  // 3 horizontal grid lines: min, mid, max
  const gridLines = [vMin, (vMin + vMax) / 2, vMax].map(v => {
    const gy = toY(v);
    return `
      <line x1="${px1}" y1="${gy.toFixed(1)}" x2="${px2}" y2="${gy.toFixed(1)}"
        stroke="#30363d" stroke-width="0.5"/>
      <text x="${px1 - 3}" y="${gy.toFixed(1)}" class="graph-label"
        dominant-baseline="middle" text-anchor="end">${fmtVal(v)}</text>`;
  }).join('');

  // Dots: small at each point, larger at the most recent
  const dots = coords.map(([x, y], i) => {
    const r   = i === coords.length - 1 ? GRAPH_DOT_R : GRAPH_DOT_R_SMALL;
    const op  = i === coords.length - 1 ? 1 : 0.5;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}" opacity="${op}"/>`;
  }).join('');

  return `
  <svg viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" class="graph-svg">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${color}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${areaPath}" fill="url(#${gradId})"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="${GRAPH_STROKE_W}"
      stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${px1}"  y="${GRAPH_H - 2}" class="graph-label" text-anchor="start">${fmtRelTime(tMin)}</text>
    <text x="${px2}"  y="${GRAPH_H - 2}" class="graph-label" text-anchor="end">now</text>
  </svg>`;
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

  const movCls    = d.movement_cls || 'tracking';
  const distColor = movCls === 'closer' ? COLOR_CLOSER
                  : movCls === 'away'   ? COLOR_AWAY
                  : COLOR_STABLE;

  // Unique gradient IDs per device to avoid SVG conflicts
  const addrSlug  = d.address.replace(/:/g, '');
  const rssiGraph = drawGraph(d.history || [], 'rssi',     { color: COLOR_RSSI, gradId: `gr-${addrSlug}` });
  const distGraph = drawGraph(d.history || [], 'distance', { color: distColor,  gradId: `gd-${addrSlug}` });

  const staleClass   = d.active ? '' : ' stale';
  const lastSeenNote = d.active ? '' : `<div class="last-seen">Last seen ${Math.round(d.last_seen_s)}s ago</div>`;

  return `
  <div class="card${staleClass}">
    <div class="card-header">
      <div>
        <div class="card-name">${escHtml(d.name)}</div>
        <div class="card-addr">${escHtml(d.address)}</div>
      </div>
      ${addrBadge}
    </div>

    ${lastSeenNote}

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
        <div class="graph-title">RSSI <span class="graph-unit">(dBm)</span></div>
        ${rssiGraph}
      </div>
      <div class="graph-block">
        <div class="graph-title">Distance <span class="graph-unit">(m)</span></div>
        ${distGraph}
      </div>
    </div>

    <div class="device-status status-${movCls}">${escHtml(d.movement_label || 'Tracking\u2026')}</div>
  </div>`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
