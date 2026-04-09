from flask import Blueprint, jsonify, request
from ..bluetooth.scanner import get_bluetooth_devices

api_bp = Blueprint("api", __name__)


@api_bp.get("/devices")
def list_devices():
    timeout = float(request.args.get("timeout", 5.0))
    try:
        devices = get_bluetooth_devices(timeout=timeout)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 503
    return jsonify({"devices": devices, "count": len(devices)})
