// ── Configuration ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS       = 10_000;
const COUNTDOWN_TICK_MS      = 500;
const DEFAULT_SCAN_TIMEOUT_S = 8;       // WiFi scans take longer than BLE

const QUALITY_HIGH           = 60;
const QUALITY_MEDIUM         = 30;

const SORT_FALLBACK_RSSI     = -200;
const SORT_FALLBACK_DISTANCE = 9_999;

// Graph SVG geometry (viewBox units)
const GRAPH_W           = 260;
const GRAPH_H           = 80;
const GRAPH_PT          = 8;
const GRAPH_PB          = 16;
const GRAPH_PL          = 30;
const GRAPH_PR          = 6;
const GRAPH_STROKE_W    = 1.8;
const GRAPH_DOT_R       = 3;
const GRAPH_DOT_R_SMALL = 1.5;

// Colours
const COLOR_RSSI        = '#58a6ff';
const COLOR_CLOSER      = '#3fb950';
const COLOR_AWAY        = '#f85149';
const COLOR_STABLE      = '#d29922';

// API
const API_DEVICES_PATH  = '/api/wifi/devices';
const API_RESET_PATH    = '/api/wifi/reset';

// Element IDs
const EL_STATUS_BAR     = 'statusBar';
const EL_STATUS_TEXT    = 'statusText';
const EL_COUNTDOWN      = 'countdown';
const EL_SCAN_BTN       = 'scanBtn';
const EL_AUTO_BTN       = 'autoToggleBtn';
const EL_CLEAR_BTN      = 'clearBtn';
const EL_ENV_SELECT     = 'envSelect';
const EL_TIMEOUT_INPUT  = 'timeout';
const EL_FILTER_INPUT   = 'filterInput';
const EL_SORT_SELECT    = 'sortSelect';
const EL_GRID           = 'grid';

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
  setStatus('busy', `Scanning for ${timeout}s — please wait\u2026`);

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
    setStatus('ok', `${active} active, ${allDevices.length - active} stale \u2014 last updated ${now}`);
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
      (d.ssid     || '').toLowerCase().includes(filter) ||
      (d.bssid    || '').toLowerCase().includes(filter) ||
      (d.vendor   || '').toLowerCase().includes(filter) ||
      (d.security || '').toLowerCase().includes(filter) ||
      (d.band     || '').toLowerCase().includes(filter)
    );
  });

  devices = [...devices].sort((a, b) => {
    switch (sort) {
      case 'rssi':     return (b.rssi ?? SORT_FALLBACK_RSSI) - (a.rssi ?? SORT_FALLBACK_RSSI);
      case 'distance': return (a.estimated_distance_m ?? SORT_FALLBACK_DISTANCE) - (b.estimated_distance_m ?? SORT_FALLBACK_DISTANCE);
      case 'name':     return (a.ssid || 'zz').localeCompare(b.ssid || 'zz');
      case 'quality':  return (b.signal_quality_pct ?? 0) - (a.signal_quality_pct ?? 0);
      default:         return 0;
    }
  });

  if (devices.length === 0 && allDevices.length === 0) {
    grid.innerHTML = `<div id="placeholder"><div class="big">&#x1F4F6;</div>Hit <strong>Scan</strong> to discover nearby WiFi networks.</div>`;
    return;
  }
  if (devices.length === 0) {
    grid.innerHTML = `<div id="placeholder"><div class="big">&#x1F50D;</div>No networks match your filter.</div>`;
    return;
  }

  grid.innerHTML = devices.map(cardHTML).join('');
}

// ── Graph ─────────────────────────────────────────────────────────────────────

function fmtRelTime(t) {
  if (Math.abs(t) < 1) return 'now';
  const s = Math.abs(Math.round(t));
  if (s < 60) return `-${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `-${m}m${rem}s` : `-${m}m`;
}

function fmtVal(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

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

  const px1 = GRAPH_PL, px2 = GRAPH_W - GRAPH_PR;
  const py1 = GRAPH_PT, py2 = GRAPH_H - GRAPH_PB;
  const pw  = px2 - px1;
  const ph  = py2 - py1;

  const toX = t => px1 + ((t - tMin) / tRange) * pw;
  const toY = v => py2 - ((v - vMin) / vRange) * ph;

  const coords = pts.map(p => [toX(p.t), toY(p.v)]);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords.at(-1)[0].toFixed(1)},${py2} L${coords[0][0].toFixed(1)},${py2} Z`;

  const gridLines = [vMin, (vMin + vMax) / 2, vMax].map(v => {
    const gy = toY(v);
    return `
      <line x1="${px1}" y1="${gy.toFixed(1)}" x2="${px2}" y2="${gy.toFixed(1)}"
        stroke="#30363d" stroke-width="0.5"/>
      <text x="${px1 - 3}" y="${gy.toFixed(1)}" class="graph-label"
        dominant-baseline="middle" text-anchor="end">${fmtVal(v)}</text>`;
  }).join('');

  const dots = coords.map(([x, y], i) => {
    const r  = i === coords.length - 1 ? GRAPH_DOT_R : GRAPH_DOT_R_SMALL;
    const op = i === coords.length - 1 ? 1 : 0.5;
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

  // Band badge: colour-coded by frequency
  const bandSlug  = d.band?.includes('2.4') ? '24' : d.band?.includes('6') ? '6' : '5';
  const bandBadge = `<span class="badge badge-band-${bandSlug}">${escHtml(d.band || '')}</span>`;

  // Security badge: warn on open networks
  const secType   = (d.security || 'Unknown');
  const secCls    = secType === 'Open'          ? 'sec-open'
                  : secType.includes('WPA3')    ? 'sec-wpa3'
                  : 'sec-wpa2';
  const secBadge  = `<span class="badge badge-${secCls}">${escHtml(secType)}</span>`;

  // Vendor badge (only when known)
  const vendorBadge = d.vendor
    ? `<span class="badge badge-vendor">${escHtml(d.vendor)}</span>` : '';

  const tagSection = (vendorBadge || secBadge || bandBadge)
    ? `<div class="tags">${vendorBadge}${secBadge}${bandBadge}</div>` : '';

  const distTxt  = d.estimated_distance_m != null ? `~${d.estimated_distance_m} m` : 'n/a';
  const chanTxt  = d.channel != null ? `Ch\u00a0${d.channel}` : 'n/a';
  const freqTxt  = d.frequency_mhz ? `${d.frequency_mhz}\u00a0MHz` : 'n/a';

  const movCls    = d.movement_cls || 'tracking';
  const distColor = movCls === 'closer' ? COLOR_CLOSER
                  : movCls === 'away'   ? COLOR_AWAY
                  : COLOR_STABLE;

  const bssidSlug = d.bssid.replace(/:/g, '');
  const rssiGraph = drawGraph(d.history || [], 'rssi',     { color: COLOR_RSSI, gradId: `gr-${bssidSlug}` });
  const distGraph = drawGraph(d.history || [], 'distance', { color: distColor,  gradId: `gd-${bssidSlug}` });

  const staleClass   = d.active ? '' : ' stale';
  const lastSeenNote = d.active ? '' : `<div class="last-seen">Last seen ${Math.round(d.last_seen_s)}s ago</div>`;

  return `
  <div class="card${staleClass}">
    <div class="card-header">
      <div>
        <div class="card-name">${escHtml(d.ssid)}</div>
        <div class="card-addr">${escHtml(d.bssid)}</div>
      </div>
      ${bandBadge}
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
      <span class="meta-key">Channel</span><span class="meta-val">${chanTxt}</span>
      <span class="meta-key">Frequency</span><span class="meta-val">${freqTxt}</span>
      <span class="meta-key">Security</span><span class="meta-val">${escHtml(secType)}</span>
    </div>

    ${tagSection}

    <div class="graphs">
      <div class="graph-block">
        <div class="graph-title">Signal <span class="graph-unit">(dBm)</span></div>
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
