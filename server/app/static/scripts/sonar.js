'use strict';

// ── Configuration ─────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 15_000;
const COUNTDOWN_TICK_MS = 500;
const SWEEP_PERIOD_MS   = 9_000;

let RADAR_MAX_DIST_M = 50;  // mutable; updated by range selector
let RADAR_RINGS_M    = [5, 10, 20, 35, 50];

// BLE spectrum (zoomed 2.4 GHz)
const BLE_SPEC_MIN    = 2400;
const BLE_SPEC_MAX    = 2485;
const BLE_ADV_CHANS   = [{ ch: 37, f: 2402 }, { ch: 38, f: 2426 }, { ch: 39, f: 2480 }];

// WiFi spectrum (multi-band)
const WIFI_SPEC_MIN   = 2400;
const WIFI_SPEC_MAX   = 5950;

// Colours
const C_BLE_ACTIVE   = '#58a6ff';
const C_BLE_STALE    = 'rgba(88,166,255,0.4)';
const C_BLE_GLOW     = 'rgba(88,166,255,0.18)';
const C_WIFI_ACTIVE  = '#f0883e';
const C_WIFI_STALE   = 'rgba(240,136,62,0.4)';
const C_WIFI_GLOW    = 'rgba(240,136,62,0.18)';
const C_SWEEP_LINE   = 'rgba(63,185,80,0.85)';
const C_SWEEP_TRAIL  = 'rgba(63,185,80,0.055)';
const C_RING         = 'rgba(48,54,61,0.85)';
const C_RING_LABEL   = '#8b949e';
const C_BG           = '#0d1117';
const C_SURFACE      = '#161b22';

// ── Log-distance scale helper ─────────────────────────────────────────────────
// Maps real-world distance → canvas pixel radius using a log scale so nearby
// devices have more visual separation while far ones are still visible.
function logR(distM, maxDistM, canvasR) {
  const d = Math.max(0, Math.min(distM, maxDistM));
  return Math.log(d + 1) / Math.log(maxDistM + 1) * canvasR;
}

// ── State ─────────────────────────────────────────────────────────────────────
let allDevices          = [];
let selectedId          = null;   // clicked selection
let hoveredCanvasId     = null;   // hovered on radar canvas
let hoveredSpecBleId    = null;   // hovered bar on BLE spectrum
let hoveredSpecWifiId   = null;   // hovered bar on WiFi spectrum
let sweepStart          = performance.now();

let pollTimer           = null;
let countdownTimer      = null;
let nextPollAt          = null;
let isScanning          = false;

let modalDeviceId       = null;
let modalCloseTimer     = null;
let modalRowEnterTimer  = null;

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvases();
  window.addEventListener('resize', () => { resizeCanvases(); redrawStatic(); });
  requestAnimationFrame(animLoop);
  setupCanvasHover();
  setupSidebarHover();
  setupSpectrumHover();
});

// ── Range selector ────────────────────────────────────────────────────────────
function updateRange() {
  const v = parseInt(document.getElementById('rangeSelect').value, 10);
  RADAR_MAX_DIST_M = v;
  if      (v <= 15) RADAR_RINGS_M = [1, 3, 5, 10, 15];
  else if (v <= 30) RADAR_RINGS_M = [5, 10, 15, 20, 30];
  else if (v <= 50) RADAR_RINGS_M = [5, 10, 20, 35, 50];
  else if (v <= 75) RADAR_RINGS_M = [10, 20, 35, 50, 75];
  else              RADAR_RINGS_M = [10, 25, 50, 75, 100];
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────
function radarPx() {
  return Math.min(500, document.getElementById('radarPanel').clientWidth - 48);
}

function specWidth() {
  return document.getElementById('radarPanel').clientWidth - 48;
}

function resizeCanvases() {
  const sz = radarPx();
  const rc = document.getElementById('radarCanvas');
  rc.width = sz; rc.height = sz;

  const sw = specWidth();
  document.getElementById('bleSpectrumCanvas').width  = sw;
  document.getElementById('wifiSpectrumCanvas').width = sw;
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animLoop() {
  drawRadar(allDevices);
  requestAnimationFrame(animLoop);
}

function redrawStatic() {
  drawBleSpectrum (allDevices.filter(d => d.type === 'ble'),  hoveredSpecBleId);
  drawWifiSpectrum(allDevices.filter(d => d.type === 'wifi'), hoveredSpecWifiId);
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(cls, text) {
  document.getElementById('statusBar').className    = cls;
  document.getElementById('statusText').textContent = text;
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();
  nextPollAt = Date.now() + POLL_INTERVAL_MS;
  countdownTimer = setInterval(() => {
    const rem = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
    document.getElementById('countdown').textContent = `Next in ${rem}s`;
    if (rem === 0) stopCountdown();
  }, COUNTDOWN_TICK_MS);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  document.getElementById('countdown').textContent = '';
}

// ── Scanning ──────────────────────────────────────────────────────────────────
function startScan() {
  if (isScanning) return;
  isScanning = true;
  const btn = document.getElementById('scanBtn');
  btn.textContent = 'Scanning\u2026';
  btn.disabled    = true;
  btn.classList.add('scanning');
  setStatus('busy', 'Running BLE + WiFi scan in parallel\u2026');

  const timeout = parseFloat(document.getElementById('timeout').value) || 5;
  const env     = document.getElementById('envSelect').value;

  fetch(`/api/sonar/snapshot?timeout=${timeout}&environment=${env}`)
    .then(r => r.json())
    .then(onData)
    .catch(err => setStatus('err', 'Fetch error: ' + err))
    .finally(() => {
      isScanning = false;
      btn.textContent = 'Scan';
      btn.disabled    = false;
      btn.classList.remove('scanning');
    });
}

function onData(data) {
  allDevices = data.devices || [];
  const errs = data.errors || {};
  const bleN = data.ble_count ?? 0, wifiN = data.wifi_count ?? 0;

  const errParts = Object.entries(errs).map(([k, v]) => `${k}: ${v}`);
  if (errParts.length) setStatus('err', `Partial scan — ${errParts.join('; ')}`);
  else setStatus('ok', `Found ${bleN} BLE + ${wifiN} WiFi device${(bleN + wifiN) !== 1 ? 's' : ''}.`);

  document.getElementById('bleCount').textContent  = `${bleN} device${bleN  !== 1 ? 's' : ''}`;
  document.getElementById('wifiCount').textContent = `${wifiN} network${wifiN !== 1 ? 's' : ''}`;

  const bleDevs  = allDevices.filter(d => d.type === 'ble');
  const wifiDevs = allDevices.filter(d => d.type === 'wifi');

  drawBleSpectrum (bleDevs,  hoveredSpecBleId);
  drawWifiSpectrum(wifiDevs, hoveredSpecWifiId);
  renderBleList(bleDevs);
  renderWifiList(wifiDevs);

  // Keep modal in sync if open
  if (modalDeviceId) {
    const updated = allDevices.find(d => d.id === modalDeviceId);
    if (updated) renderModalBody(updated);
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  const btn = document.getElementById('resetBtn');
  btn.disabled = true;
  btn.textContent = 'Resetting…';

  Promise.all([
    fetch('/api/bluetooth/reset', { method: 'POST' }),
    fetch('/api/wifi/reset',      { method: 'POST' }),
  ])
    .then(() => {
      allDevices = [];
      selectedId = null;
      hoveredCanvasId = null;
      forceCloseModal();
      document.getElementById('bleCount').textContent  = '0 devices';
      document.getElementById('wifiCount').textContent = '0 networks';
      document.getElementById('bleDeviceList').innerHTML  = '<div class="section-empty">Data cleared — hit <strong>Scan</strong> to rediscover.</div>';
      document.getElementById('wifiDeviceList').innerHTML = '<div class="section-empty">Data cleared — hit <strong>Scan</strong> to rediscover.</div>';
      drawBleSpectrum([], null);
      drawWifiSpectrum([], null);
      setStatus('ok', 'All device history cleared.');
    })
    .catch(err => setStatus('err', 'Reset failed: ' + err))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Reset';
    });
}

// ── Auto-poll ─────────────────────────────────────────────────────────────────
function toggleAutoPoll() {
  const btn = document.getElementById('autoToggleBtn');
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    stopCountdown();
    btn.textContent = 'Auto: Off';
    btn.classList.remove('active');
  } else {
    startScan();
    pollTimer = setInterval(() => { startScan(); startCountdown(); }, POLL_INTERVAL_MS);
    startCountdown();
    btn.textContent = 'Auto: On';
    btn.classList.add('active');
  }
}

// ── Radar canvas drawing ──────────────────────────────────────────────────────
function drawRadar(devices) {
  const canvas = document.getElementById('radarCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(W, H) / 2 - 22;

  ctx.clearRect(0, 0, W, H);

  // Background disk
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fillStyle = C_BG;
  ctx.fill();

  // Crosshair
  ctx.save();
  ctx.strokeStyle = 'rgba(48,54,61,0.5)';
  ctx.lineWidth   = 0.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Distance rings (log-scaled radii, labelled with real distances)
  for (const rm of RADAR_RINGS_M) {
    const pr = logR(rm, RADAR_MAX_DIST_M, R);
    ctx.beginPath();
    ctx.arc(cx, cy, pr, 0, 2 * Math.PI);
    ctx.strokeStyle = C_RING;
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.fillStyle  = C_RING_LABEL;
    ctx.font       = '9px monospace';
    ctx.textAlign  = 'center';
    ctx.fillText(rm + 'm', cx, cy - pr + 10);
  }

  // Outer border
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Sweep angle
  const elapsed  = performance.now() - sweepStart;
  const sweepRad = ((elapsed % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 2 * Math.PI - Math.PI / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.clip();

  // Sweep trail
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, sweepRad - (2 * Math.PI * 100 / 360), sweepRad);
  ctx.closePath();
  ctx.fillStyle = C_SWEEP_TRAIL;
  ctx.fill();

  // Device dots — far/stale painted first, near/active on top
  const sorted = [...devices].sort((a, b) => {
    if (a.active !== b.active) return a.active ? 1 : -1;
    return (b.estimated_distance_m ?? RADAR_MAX_DIST_M) - (a.estimated_distance_m ?? RADAR_MAX_DIST_M);
  });

  for (const dev of sorted) {
    const dist    = Math.min(dev.estimated_distance_m ?? RADAR_MAX_DIST_M, RADAR_MAX_DIST_M);
    const pr      = logR(dist, RADAR_MAX_DIST_M, R);
    const a       = (dev.angle_deg - 90) * Math.PI / 180;
    const x       = cx + pr * Math.cos(a);
    const y       = cy + pr * Math.sin(a);
    const quality = dev.signal_quality_pct ?? 50;
    const dotR    = 4 + (quality / 100) * 6;
    const isBle   = dev.type === 'ble';
    const isHov   = dev.id === hoveredCanvasId || dev.id === selectedId;
    const color   = isBle
      ? (dev.active ? C_BLE_ACTIVE  : C_BLE_STALE)
      : (dev.active ? C_WIFI_ACTIVE : C_WIFI_STALE);
    const glowCol = isBle ? C_BLE_GLOW : C_WIFI_GLOW;

    // Approach glow
    if (dev.movement_cls === 'closer' && dev.active) {
      ctx.beginPath();
      ctx.arc(x, y, dotR + 7, 0, 2 * Math.PI);
      ctx.fillStyle = glowCol;
      ctx.fill();
    }

    // Hover / selected highlight ring (under dot)
    if (isHov) {
      ctx.beginPath();
      ctx.arc(x, y, dotR + 6, 0, 2 * Math.PI);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Main dot
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Thin protocol ring
    ctx.beginPath();
    ctx.arc(x, y, dotR + 1.5, 0, 2 * Math.PI);
    ctx.strokeStyle = isBle ? 'rgba(88,166,255,0.3)' : 'rgba(240,136,62,0.3)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Label — only on hover/selection; hidden otherwise to keep radar clean
    if (isHov) {
      ctx.fillStyle = '#ffffff';
      ctx.font      = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText((dev.label || dev.id).substring(0, 18), x, y - dotR - 5);
    }
  }

  // Sweep line (top)
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + (R + 4) * Math.cos(sweepRad), cy + (R + 4) * Math.sin(sweepRad));
  ctx.strokeStyle = C_SWEEP_LINE;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Center
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
  ctx.fillStyle = '#3fb950';
  ctx.fill();

  ctx.restore(); // end disk clip

  // "log scale" annotation — drawn after clip so it sits at the bottom inside the circle
  ctx.fillStyle = 'rgba(139,148,158,0.4)';
  ctx.font      = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('logarithmic scale', cx, cy + R - 7);
}

// ── Canvas hover detection ────────────────────────────────────────────────────
function setupCanvasHover() {
  const canvas = document.getElementById('radarCanvas');

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = findDeviceAtPoint(canvas, mx, my);
    const hitId = hit?.id ?? null;

    if (hitId !== hoveredCanvasId) {
      hoveredCanvasId = hitId;
      syncSidebarHighlight(hoveredCanvasId);
    }

    if (hit) showRadarTooltip(e.clientX, e.clientY, hit);
    else     hideRadarTooltip();
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredCanvasId = null;
    syncSidebarHighlight(null);
    hideRadarTooltip();
  });

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const hit  = findDeviceAtPoint(canvas, e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      selectedId = selectedId === hit.id ? null : hit.id;
      rerenderLists();
    }
  });
}

function findDeviceAtPoint(canvas, mx, my) {
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(W, H) / 2 - 22;
  const HIT_R = 14;

  let best = null, bestD = Infinity;
  for (const dev of allDevices) {
    const dist = Math.min(dev.estimated_distance_m ?? RADAR_MAX_DIST_M, RADAR_MAX_DIST_M);
    const pr   = logR(dist, RADAR_MAX_DIST_M, R);
    const a    = (dev.angle_deg - 90) * Math.PI / 180;
    const dx   = mx - (cx + pr * Math.cos(a));
    const dy   = my - (cy + pr * Math.sin(a));
    const d    = Math.hypot(dx, dy);
    if (d < HIT_R && d < bestD) { best = dev; bestD = d; }
  }
  return best;
}

function syncSidebarHighlight(id) {
  document.querySelectorAll('.device-row.canvas-highlight')
          .forEach(el => el.classList.remove('canvas-highlight'));
  if (!id) return;
  const el = document.querySelector(`.device-row[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.add('canvas-highlight');
  // Scroll only within the sidebar panel — never scroll the outer page
  const panel     = document.getElementById('devicePanel');
  const panelRect = panel.getBoundingClientRect();
  const elRect    = el.getBoundingClientRect();
  const HEADER_H  = 34; // approximate sticky section-header height
  if (elRect.top < panelRect.top + HEADER_H) {
    panel.scrollTop += elRect.top - panelRect.top - HEADER_H;
  } else if (elRect.bottom > panelRect.bottom) {
    panel.scrollTop += elRect.bottom - panelRect.bottom + 4;
  }
}

// ── Tooltip (shared by radar canvas + spectrum canvases) ─────────────────────
function showRadarTooltip(cx, cy, dev, extraLine) {
  const tt   = document.getElementById('radarTooltip');
  const dist = dev.estimated_distance_m != null
    ? dev.estimated_distance_m.toFixed(1) + ' m' : '— m';
  document.getElementById('ttName').textContent = (dev.label || dev.id).substring(0, 32);
  document.getElementById('ttDist').textContent = dist + '  ·  ' + (dev.rssi ?? '—') + ' dBm';
  document.getElementById('ttRssi').textContent = extraLine ?? dev.movement_label ?? '';
  tt.style.display = 'block';
  const offX = 14, offY = -10;
  const vw = window.innerWidth;
  let tx = cx + offX, ty = cy + offY;
  if (tx + 220 > vw) tx = cx - 220 - offX;
  if (ty < 10)       ty = cy + 20;
  tt.style.left = tx + 'px';
  tt.style.top  = ty + 'px';
}

function hideRadarTooltip() {
  document.getElementById('radarTooltip').style.display = 'none';
}

// ── Spectrum canvas hover ─────────────────────────────────────────────────────
function setupSpectrumHover() {
  // BLE spectrum
  const bleCvs = document.getElementById('bleSpectrumCanvas');
  if (bleCvs) {
    bleCvs.style.cursor = 'crosshair';
    bleCvs.addEventListener('mousemove', e => {
      const rect = bleCvs.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const hit  = findBleSpectrumDevice(bleCvs, mx);
      const hitId = hit?.id ?? null;
      if (hitId !== hoveredSpecBleId) {
        hoveredSpecBleId = hitId;
        drawBleSpectrum(allDevices.filter(d => d.type === 'ble'), hoveredSpecBleId);
        if (hitId) syncSidebarHighlight(hitId);
        else       syncSidebarHighlight(hoveredCanvasId);  // restore canvas hover if any
      }
      if (hit) {
        const extra = hit.movement_label ?? '';
        showRadarTooltip(e.clientX, e.clientY, hit, extra);
      } else {
        hideRadarTooltip();
      }
    });
    bleCvs.addEventListener('mouseleave', () => {
      if (hoveredSpecBleId) {
        hoveredSpecBleId = null;
        drawBleSpectrum(allDevices.filter(d => d.type === 'ble'), null);
        syncSidebarHighlight(hoveredCanvasId);
      }
      hideRadarTooltip();
    });
  }

  // WiFi spectrum
  const wifiCvs = document.getElementById('wifiSpectrumCanvas');
  if (wifiCvs) {
    wifiCvs.style.cursor = 'crosshair';
    wifiCvs.addEventListener('mousemove', e => {
      const rect = wifiCvs.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const hit  = findWifiSpectrumDevice(wifiCvs, mx);
      const hitId = hit?.id ?? null;
      if (hitId !== hoveredSpecWifiId) {
        hoveredSpecWifiId = hitId;
        drawWifiSpectrum(allDevices.filter(d => d.type === 'wifi'), hoveredSpecWifiId);
        if (hitId) syncSidebarHighlight(hitId);
        else       syncSidebarHighlight(hoveredCanvasId);
      }
      if (hit) {
        const extra = hit.band
          ? `${escHtml(hit.band)}${hit.channel != null ? ' · ch' + hit.channel : ''} · ${hit.movement_label ?? ''}`
          : hit.movement_label ?? '';
        showRadarTooltip(e.clientX, e.clientY, hit, extra);
      } else {
        hideRadarTooltip();
      }
    });
    wifiCvs.addEventListener('mouseleave', () => {
      if (hoveredSpecWifiId) {
        hoveredSpecWifiId = null;
        drawWifiSpectrum(allDevices.filter(d => d.type === 'wifi'), null);
        syncSidebarHighlight(hoveredCanvasId);
      }
      hideRadarTooltip();
    });
  }
}

function findBleSpectrumDevice(canvas, mx) {
  const W = canvas.width;
  const PL = 36, PR = 10;
  const plotW = W - PL - PR;
  const fX = f => PL + ((f - BLE_SPEC_MIN) / (BLE_SPEC_MAX - BLE_SPEC_MIN)) * plotW;
  const HIT = 9;
  let best = null, bestD = Infinity;
  for (const dev of allDevices.filter(d => d.type === 'ble')) {
    const bx = fX(2402 + (dev.angle_deg / 360) * (2480 - 2402));
    const d  = Math.abs(mx - bx);
    if (d < HIT && d < bestD) { best = dev; bestD = d; }
  }
  return best;
}

function findWifiSpectrumDevice(canvas, mx) {
  const W = canvas.width;
  const PL = 36, PR = 10;
  const plotW = W - PL - PR;
  const fX = f => PL + ((f - WIFI_SPEC_MIN) / (WIFI_SPEC_MAX - WIFI_SPEC_MIN)) * plotW;
  const HIT = 9;
  let best = null, bestD = Infinity;
  for (const dev of allDevices.filter(d => d.type === 'wifi' && d.frequency_mhz)) {
    const bx = fX(dev.frequency_mhz);
    const d  = Math.abs(mx - bx);
    if (d < HIT && d < bestD) { best = dev; bestD = d; }
  }
  return best;
}

// ── Sidebar hover → detail modal ──────────────────────────────────────────────
function setupSidebarHover() {
  ['bleDeviceList', 'wifiDeviceList'].forEach(listId => {
    const el = document.getElementById(listId);

    el.addEventListener('mouseenter', e => {
      const row = e.target.closest('.device-row');
      if (!row) return;
      clearTimeout(modalCloseTimer);
      clearTimeout(modalRowEnterTimer);
      modalRowEnterTimer = setTimeout(() => openModal(row.dataset.id), 80);
    }, true);

    el.addEventListener('mouseleave', e => {
      const row = e.target.closest('.device-row');
      if (!row) return;
      clearTimeout(modalRowEnterTimer);
      scheduleModalClose();
    }, true);
  });
}

function openModal(id) {
  const dev = allDevices.find(d => d.id === id);
  if (!dev) return;
  modalDeviceId = id;

  document.getElementById('modalName').textContent = dev.label || dev.id;
  document.getElementById('modalId').textContent   = dev.id;
  renderModalBody(dev);

  const modal = document.getElementById('deviceModal');
  modal.classList.add('visible');
}

function renderModalBody(dev) {
  const body    = document.getElementById('modalBody');
  const quality = dev.signal_quality_pct ?? 0;
  const qClass  = quality >= 60 ? 'high' : quality >= 30 ? 'medium' : 'low';
  const dist    = dev.estimated_distance_m != null ? dev.estimated_distance_m.toFixed(2) + ' m' : '—';
  const movCls  = 'status-' + (dev.movement_cls || 'tracking');

  // Protocol-specific extra rows
  let extraRows = '';
  if (dev.type === 'ble') {
    const rows = [
      ['Address type', dev.address_type],
      ['TX power',     dev.tx_power != null ? dev.tx_power + ' dBm' : null],
      ['Apple device', dev.is_apple  ? 'Yes' : null],
      ['MS device',    dev.is_microsoft ? 'Yes' : null],
      ['Companies',    (dev.known_companies  || []).join(', ') || null],
      ['Profiles',     (dev.device_profiles  || []).join(', ') || null],
    ].filter(([, v]) => v);
    if (rows.length) {
      extraRows = `<div class="modal-section-title">BLE Details</div>
        <div class="modal-kv">${rows.map(([k,v]) =>
          `<span class="modal-kv-key">${escHtml(k)}</span><span class="modal-kv-val">${escHtml(v)}</span>`
        ).join('')}</div>`;
    }
  } else {
    const rows = [
      ['Band',      dev.band],
      ['Channel',   dev.channel != null ? 'ch ' + dev.channel : null],
      ['Frequency', dev.frequency_mhz ? dev.frequency_mhz + ' MHz' : null],
      ['Security',  dev.security],
      ['Vendor',    dev.vendor],
    ].filter(([, v]) => v);
    if (rows.length) {
      extraRows = `<div class="modal-section-title">WiFi Details</div>
        <div class="modal-kv">${rows.map(([k,v]) =>
          `<span class="modal-kv-key">${escHtml(k)}</span><span class="modal-kv-val">${escHtml(v)}</span>`
        ).join('')}</div>`;
    }
  }

  // Tags / badges
  const tags = [];
  if (dev.type === 'ble') {
    if (dev.is_apple)     tags.push(['Apple',     'badge-apple']);
    if (dev.is_microsoft) tags.push(['Microsoft', 'badge-ms']);
    (dev.device_profiles || []).forEach(p => tags.push([p, 'badge-profile']));
    const addrCls = dev.address_type === 'random' ? 'badge-random' : 'badge-public';
    tags.push([dev.address_type || 'public', addrCls]);
  } else {
    if (dev.band) {
      const cls = dev.band.startsWith('5') ? 'badge-band-5' : dev.band.startsWith('6') ? 'badge-band-6' : 'badge-band-24';
      tags.push([dev.band, cls]);
    }
    if (dev.security) {
      const cls = dev.security.includes('WPA3') ? 'badge-sec-wpa3' : dev.security.includes('WPA') ? 'badge-sec-wpa2' : 'badge-sec-open';
      tags.push([dev.security, cls]);
    }
    if (dev.vendor) tags.push([dev.vendor, 'badge-vendor']);
  }

  const tagsHtml = tags.length
    ? `<div class="modal-tags">${tags.map(([t,c]) => `<span class="badge ${c}">${escHtml(t)}</span>`).join('')}</div>`
    : '';

  // SVG graphs
  const hist = dev.history || [];
  const rssiSvg = buildGraphSvg(hist, 'rssi',     '#58a6ff', 'dBm', -100, -30);
  const distSvg = buildGraphSvg(hist, 'distance', '#f0883e', 'm',     0, null);

  body.innerHTML = `
    <div class="modal-metrics">
      <span class="mm-key">RSSI</span>       <span class="mm-val">${dev.rssi ?? '—'} dBm</span>
      <span class="mm-key">Distance</span>   <span class="mm-val">${dist}</span>
      <span class="mm-key">Last seen</span>  <span class="mm-val">${dev.last_seen_s != null ? dev.last_seen_s + 's ago' : '—'}</span>
      <span class="mm-key">Type</span>       <span class="mm-val">${escHtml(dev.type.toUpperCase())}</span>
    </div>

    <div class="modal-quality-bar">
      <span style="color:var(--muted);font-size:.7rem;width:3.5rem">Quality</span>
      <div class="bar-track"><div class="bar-fill ${qClass}" style="width:${quality}%"></div></div>
      <span style="font-size:.72rem;font-family:monospace;color:var(--text);width:2.5rem;text-align:right">${quality}%</span>
    </div>

    <div class="modal-movement ${movCls}">${escHtml(dev.movement_label || 'Tracking…')}</div>

    ${tagsHtml}

    <div class="modal-section-title">RSSI over time</div>
    <div class="modal-graph">${rssiSvg}</div>

    <div class="modal-section-title">Distance over time</div>
    <div class="modal-graph">${distSvg}</div>

    ${extraRows}
  `;
}

function scheduleModalClose() {
  clearTimeout(modalCloseTimer);
  modalCloseTimer = setTimeout(closeModal, 220);
}

function cancelModalClose() {
  clearTimeout(modalCloseTimer);
}

function closeModal() {
  modalDeviceId = null;
  document.getElementById('deviceModal').classList.remove('visible');
}

function forceCloseModal() {
  clearTimeout(modalCloseTimer);
  closeModal();
}

// ── SVG graph builder ─────────────────────────────────────────────────────────
function buildGraphSvg(history, key, color, unit, yFloor, yCeil) {
  const W = 290, H = 62;
  const PL = 30, PR = 8, PT = 6, PB = 18;
  const plotW = W - PL - PR, plotH = H - PT - PB;

  const valid = (history || []).filter(h => h[key] != null);
  if (!valid.length) {
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block">
      <text x="${W/2}" y="${H/2+4}" text-anchor="middle" fill="#8b949e" font-size="10" font-family="monospace">No data</text>
    </svg>`;
  }

  const times = valid.map(h => h.t);
  const vals  = valid.map(h => h[key]);
  const tMin  = Math.min(...times), tMax = Math.max(...times);
  let   vMin  = Math.min(...vals),  vMax = Math.max(...vals);
  if (yFloor != null) vMin = Math.min(vMin, yFloor);
  if (yCeil  != null) vMax = Math.max(vMax, yCeil);
  if (vMax === vMin)  { vMin -= 1; vMax += 1; }

  const tRange = tMax - tMin || 1;
  const vRange = vMax - vMin;

  const px = t => PL + ((t - tMin) / tRange) * plotW;
  const py = v => PT + (1 - (v - vMin) / vRange) * plotH;

  const points = valid.map(h => `${px(h.t).toFixed(1)},${py(h[key]).toFixed(1)}`).join(' ');
  const last   = valid[valid.length - 1];

  // y-axis labels at min and max
  const yLabels = [vMin, vMax].map(v => {
    const yp = py(v);
    return `<text x="${PL - 3}" y="${yp + 3}" text-anchor="end" fill="#8b949e" font-size="8" font-family="monospace">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`;
  }).join('');

  // x-axis label: time window
  const tLabelL = tMin.toFixed(0) + 's';
  const tLabelR = tMax.toFixed(0) + 's';

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%">
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT+plotH}" stroke="#30363d" stroke-width="1"/>
    <line x1="${PL}" y1="${PT+plotH}" x2="${PL+plotW}" y2="${PT+plotH}" stroke="#30363d" stroke-width="1"/>
    ${yLabels}
    <text x="${PL}"       y="${PT+plotH+12}" fill="#8b949e" font-size="8" font-family="monospace" text-anchor="middle">${escHtml(tLabelL)}</text>
    <text x="${PL+plotW}" y="${PT+plotH+12}" fill="#8b949e" font-size="8" font-family="monospace" text-anchor="middle">${escHtml(tLabelR)}</text>
    <text x="${PL+plotW}" y="${PT+8}"        fill="${color}" font-size="8" font-family="monospace" text-anchor="end" opacity=".7">${escHtml(unit)}</text>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${px(last.t).toFixed(1)}" cy="${py(last[key]).toFixed(1)}" r="3" fill="${color}"/>
  </svg>`;
}

// ── BLE spectrum ──────────────────────────────────────────────────────────────
function drawBleSpectrum(devs, hoveredId = null) {
  const canvas = document.getElementById('bleSpectrumCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PL = 36, PR = 10, PT = 10, PB = 20;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const baseline = PT + plotH;
  const fX = f => PL + ((f - BLE_SPEC_MIN) / (BLE_SPEC_MAX - BLE_SPEC_MIN)) * plotW;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = C_SURFACE; ctx.fillRect(0, 0, W, H);

  // Band fill
  ctx.fillStyle = 'rgba(88,166,255,0.05)';
  ctx.fillRect(fX(2402), PT, fX(2480) - fX(2402), plotH);

  // Advertising channel markers
  for (const { ch, f } of BLE_ADV_CHANS) {
    const ax = fX(f);
    ctx.save();
    ctx.strokeStyle = 'rgba(88,166,255,0.25)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ax, PT); ctx.lineTo(ax, baseline); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.fillStyle = 'rgba(88,166,255,0.5)'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText('ch' + ch, ax, PT + 8);
  }

  // Axis
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PL, baseline); ctx.lineTo(PL + plotW, baseline); ctx.stroke();

  const ticks = [2402, 2420, 2440, 2460, 2480];
  ctx.fillStyle = '#8b949e'; ctx.font = '8px monospace';
  for (const f of ticks) {
    const tx = fX(f);
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(tx, baseline - 2); ctx.lineTo(tx, baseline); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(f, tx, baseline + 11);
  }

  // dBm axis labels
  ctx.textAlign = 'right';
  for (const pct of [0, 50, 100]) {
    const y = baseline - (pct / 100) * plotH;
    ctx.fillText(Math.round(-100 + pct * 0.7) + '', PL - 3, y + 3);
  }

  // Bars — position within band derived from angle_deg
  const barW = 10;
  for (const dev of devs) {
    const freqInBand = 2402 + (dev.angle_deg / 360) * (2480 - 2402);
    const x    = fX(freqInBand);
    const q    = dev.signal_quality_pct ?? 0;
    const bh   = Math.max(3, (q / 100) * plotH);
    const isHov = dev.id === hoveredId;

    ctx.fillStyle = dev.active ? C_BLE_ACTIVE : C_BLE_STALE;
    ctx.fillRect(x - barW / 2, baseline - bh, barW, bh);

    // Hover highlight: bright outline + vertical cursor line
    if (isHov) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(x - barW / 2 - 1, baseline - bh - 1, barW + 2, bh + 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, baseline - bh - 2); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label only on hover — keeps spectrum clean
    if (isHov) {
      ctx.save();
      ctx.translate(x, baseline - bh - 6);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#ffffff';
      ctx.font      = 'bold 9px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText((dev.label || dev.id).substring(0, 14), 0, 3);
      ctx.restore();
    }
  }
}

// ── WiFi spectrum ─────────────────────────────────────────────────────────────
function drawWifiSpectrum(devs, hoveredId = null) {
  const canvas = document.getElementById('wifiSpectrumCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PL = 36, PR = 10, PT = 10, PB = 20;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const baseline = PT + plotH;
  const fX = f => PL + ((f - WIFI_SPEC_MIN) / (WIFI_SPEC_MAX - WIFI_SPEC_MIN)) * plotW;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = C_SURFACE; ctx.fillRect(0, 0, W, H);

  // Band fills
  ctx.fillStyle = 'rgba(240,136,62,0.05)'; ctx.fillRect(fX(2400), PT, fX(2484) - fX(2400), plotH);
  ctx.fillStyle = 'rgba(63,185,80,0.04)';  ctx.fillRect(fX(5150), PT, fX(5925) - fX(5150), plotH);
  ctx.fillStyle = 'rgba(199,146,234,0.05)';ctx.fillRect(fX(5925), PT, fX(5950) - fX(5925), plotH);

  // Band labels
  [{ f: 2440, lbl: '2.4G', col: 'rgba(240,136,62,0.5)' },
   { f: 5500, lbl: '5G',   col: 'rgba(63,185,80,0.5)'  },
   { f: 5935, lbl: '6G',   col: 'rgba(199,146,234,0.5)'}].forEach(({ f, lbl, col }) => {
    ctx.fillStyle = col; ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(lbl, fX(f), PT + 8);
  });

  // Axis
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PL, baseline); ctx.lineTo(PL + plotW, baseline); ctx.stroke();

  [2412, 2462, 5180, 5500, 5745, 5925].forEach(f => {
    const tx = fX(f);
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(tx, baseline - 2); ctx.lineTo(tx, baseline); ctx.stroke();
    ctx.fillStyle = '#8b949e'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(f, tx, baseline + 11);
  });

  ctx.fillStyle = '#8b949e'; ctx.textAlign = 'right';
  for (const pct of [0, 50, 100]) {
    const y = baseline - (pct / 100) * plotH;
    ctx.fillText(Math.round(-100 + pct * 0.7) + '', PL - 3, y + 3);
  }

  // Bars at actual frequency
  const barW = 10;
  for (const dev of devs) {
    if (!dev.frequency_mhz) continue;
    const x     = fX(dev.frequency_mhz);
    const q     = dev.signal_quality_pct ?? 0;
    const bh    = Math.max(3, (q / 100) * plotH);
    const b     = dev.band || '';
    const isHov = dev.id === hoveredId;
    const col   = b.startsWith('5') ? (dev.active ? '#3fb950' : 'rgba(63,185,80,0.4)')
                : b.startsWith('6') ? (dev.active ? '#c792ea' : 'rgba(199,146,234,0.4)')
                :                     (dev.active ? C_WIFI_ACTIVE : C_WIFI_STALE);
    ctx.fillStyle = col;
    ctx.fillRect(x - barW / 2, baseline - bh, barW, bh);

    // Hover highlight
    if (isHov) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(x - barW / 2 - 1, baseline - bh - 1, barW + 2, bh + 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, baseline - bh - 2); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Label only on hover — keeps spectrum clean
    if (isHov) {
      ctx.save();
      ctx.translate(x, baseline - bh - 6);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#ffffff';
      ctx.font      = 'bold 9px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText((dev.label || '').substring(0, 14), 0, 3);
      ctx.restore();
    }
    if (dev.channel != null) {
      ctx.fillStyle = isHov ? '#ffffff' : '#8b949e';
      ctx.font      = '7px monospace'; ctx.textAlign = 'center';
      ctx.fillText('ch' + dev.channel, x, baseline + 20);
    }
  }
}

// ── Device list rendering ─────────────────────────────────────────────────────
function renderBleList(devs) {
  document.getElementById('bleDeviceList').innerHTML =
    devs.length ? sortedRows(devs, '#58a6ff')
                : '<div class="section-empty">No BLE devices found.</div>';
}

function renderWifiList(devs) {
  document.getElementById('wifiDeviceList').innerHTML =
    devs.length ? sortedRows(devs, '#f0883e')
                : '<div class="section-empty">No WiFi networks found.</div>';
}

function rerenderLists() {
  renderBleList (allDevices.filter(d => d.type === 'ble'));
  renderWifiList(allDevices.filter(d => d.type === 'wifi'));
}

function sortedRows(devices, dotColor) {
  const sorted = [...devices].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.estimated_distance_m ?? 9999) - (b.estimated_distance_m ?? 9999);
  });

  return sorted.map(dev => {
    const dist = dev.estimated_distance_m != null
      ? dev.estimated_distance_m.toFixed(1) + 'm' : '\u2014';
    const sub  = dev.type === 'wifi' && dev.band
      ? `${escHtml(dev.id.substring(0,17))} &bull; ${escHtml(dev.band)}`
      : escHtml(dev.id.substring(0, 17));
    const cls = ['device-row',
      dev.id === selectedId       ? 'selected'         : '',
      dev.id === hoveredCanvasId  ? 'canvas-highlight'  : '',
      dev.active                  ? ''                  : 'stale',
    ].filter(Boolean).join(' ');

    return `<div class="${cls}" data-id="${escHtml(dev.id)}"
                 onmouseenter="onRowEnter('${escHtml(dev.id)}')"
                 onmouseleave="onRowLeave()"
                 onclick="onRowClick('${escHtml(dev.id)}')">
  <span class="device-type-dot" style="background:${dotColor}${dev.active ? '' : ';opacity:.5'}"></span>
  <div class="device-info">
    <div class="device-name">${escHtml(dev.label || dev.id)}</div>
    <div class="device-sub">${sub}</div>
  </div>
  <div class="device-right">
    <div class="device-dist">${dist}</div>
    <div class="device-mov mov-${escHtml(dev.movement_cls || 'tracking')}">${escHtml(dev.movement_label || 'Tracking\u2026')}</div>
  </div>
</div>`;
  }).join('');
}

// ── Row interaction handlers ──────────────────────────────────────────────────
function onRowEnter(id) {
  clearTimeout(modalCloseTimer);
  clearTimeout(modalRowEnterTimer);
  modalRowEnterTimer = setTimeout(() => openModal(id), 80);
}

function onRowLeave() {
  clearTimeout(modalRowEnterTimer);
  scheduleModalClose();
}

function onRowClick(id) {
  selectedId = selectedId === id ? null : id;
  rerenderLists();
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
