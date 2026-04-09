from flask import Blueprint, jsonify
from sqlalchemy import func
from ..extensions import db
from ..models import BLEDevice
from ..analysis import analyse_device

api_bp = Blueprint("api", __name__)


@api_bp.get("/devices")
def list_devices():
    # Latest record ID per distinct address
    latest_ids = (
        db.session.query(func.max(BLEDevice.id))
        .group_by(BLEDevice.address)
        .subquery()
    )
    latest = BLEDevice.query.filter(BLEDevice.id.in_(latest_ids)).all()

    result = []
    for device in latest:
        # Full time-ordered history within the retention window (already bounded by purge job)
        history = (
            BLEDevice.query.filter_by(address=device.address)
            .order_by(BLEDevice.scanned_at.asc())
            .all()
        )
        entry = device.to_dict()
        entry["analysis"] = analyse_device(history)
        result.append(entry)

    return jsonify({"devices": result, "count": len(result)})
