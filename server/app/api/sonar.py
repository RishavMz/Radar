"""
Sonar API — fused BLE + WiFi snapshot for the radar dashboard.

Both scanners run concurrently in worker threads. Each device is assigned a
deterministic pseudo-angle derived from its identifier so its position on the
polar plot stays stable across polls.

NOTE: True bearing requires multi-antenna hardware (AoA/AoD). The angle here
is hash-derived and serves only as a stable visual placement.
"""

import hashlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Blueprint, current_app, jsonify, request

sonar_bp = Blueprint("sonar", __name__)


def _angle(device_id: str) -> int:
    """Deterministic pseudo-angle (0–359°) from device identifier."""
    return int(hashlib.md5(device_id.encode()).hexdigest()[:8], 16) % 360


def _run_in_app_context(app, fn, *args, **kwargs):
    """Push an app context before calling fn (required for ORM in threads)."""
    with app.app_context():
        return fn(*args, **kwargs)


@sonar_bp.get("/snapshot")
def snapshot():
    timeout     = float(request.args.get("timeout",     5.0))
    environment = request.args.get("environment", "indoor_mixed")

    # Import singletons here to avoid circular imports at module load time.
    from app.api.bluetooth import _scanner as bt_scanner
    from app.api.wifi      import _scanner as wifi_scanner

    app     = current_app._get_current_object()
    results = {}
    errors  = {}

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(
                _run_in_app_context, app,
                bt_scanner.get_devices, timeout, environment,
            ): "ble",
            pool.submit(
                _run_in_app_context, app,
                wifi_scanner.get_devices, timeout, environment,
            ): "wifi",
        }
        for future in as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
            except RuntimeError as exc:
                results[key] = []
                errors[key]  = str(exc)

    fused = []

    for dev in results.get("ble", []):
        addr = dev.get("address", "")
        fused.append({
            **dev,                                          # all BLE fields pass through
            "id":        addr,
            "type":      "ble",
            "label":     dev.get("name") or addr[:17],
            "angle_deg": _angle(addr),
        })

    for dev in results.get("wifi", []):
        bssid = dev.get("bssid", "")
        fused.append({
            **dev,                                          # all WiFi fields pass through
            "id":        bssid,
            "type":      "wifi",
            "label":     dev.get("ssid") or bssid,
            "angle_deg": _angle(bssid),
        })

    return jsonify({
        "devices":    fused,
        "ble_count":  len(results.get("ble",  [])),
        "wifi_count": len(results.get("wifi", [])),
        "scan_time":  time.time(),
        "errors":     errors,
    })
