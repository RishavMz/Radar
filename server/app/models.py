from datetime import datetime, timezone
from .extensions import db


class BLEDevice(db.Model):
    __tablename__ = "ble_devices"

    id = db.Column(db.Integer, primary_key=True)
    scanned_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
    address = db.Column(db.String(17), nullable=False)
    name = db.Column(db.String(64))
    rssi = db.Column(db.Integer)
    tx_power = db.Column(db.Integer)
    estimated_distance_m = db.Column(db.Float)
    signal_quality_pct = db.Column(db.Integer)
    path_loss_db = db.Column(db.Integer)
    address_type = db.Column(db.String(10))
    is_apple = db.Column(db.Boolean)
    is_microsoft = db.Column(db.Boolean)
    known_companies = db.Column(db.JSON)
    device_profiles = db.Column(db.JSON)
    service_uuids = db.Column(db.JSON)
    manufacturer_data = db.Column(db.JSON)
    service_data = db.Column(db.JSON)

    def to_dict(self) -> dict:
        return {
            "address": self.address,
            "name": self.name,
            "rssi": self.rssi,
            "tx_power": self.tx_power,
            "estimated_distance_m": self.estimated_distance_m,
            "signal_quality_pct": self.signal_quality_pct,
            "path_loss_db": self.path_loss_db,
            "address_type": self.address_type,
            "is_apple": self.is_apple,
            "is_microsoft": self.is_microsoft,
            "known_companies": self.known_companies or [],
            "device_profiles": self.device_profiles or [],
            "service_uuids": self.service_uuids or [],
            "manufacturer_data": self.manufacturer_data or {},
            "service_data": self.service_data or {},
            "last_seen": self.scanned_at.isoformat() if self.scanned_at else None,
        }
