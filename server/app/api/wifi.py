from flask import Blueprint, jsonify, request

from app.wifi.scanner import WifiScanner

wifi_bp = Blueprint("wifi", __name__)

# Module-level singleton — one shared store per process.
_scanner = WifiScanner()


@wifi_bp.get("/devices")
def list_devices():
    timeout = float(request.args.get("timeout", 5.0))
    environment = request.args.get("environment", "indoor_mixed")
    try:
        devices = _scanner.get_devices(timeout=timeout, environment=environment)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503
    return jsonify({"devices": devices, "count": len(devices)})


@wifi_bp.post("/reset")
def reset_devices():
    _scanner.reset()
    return jsonify({"ok": True})
