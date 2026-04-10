from flask import Blueprint, jsonify, request
from ..bluetooth.scanner import get_bluetooth_devices, reset_store

api_bp = Blueprint("api", __name__)


@api_bp.get("/devices")
def list_devices():
    timeout     = float(request.args.get("timeout", 5.0))
    environment = request.args.get("environment", "indoor_mixed")
    try:
        devices = get_bluetooth_devices(timeout=timeout, environment=environment)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    return jsonify({"devices": devices, "count": len(devices)})


@api_bp.post("/reset")
def reset_devices():
    reset_store()
    return jsonify({"ok": True})
