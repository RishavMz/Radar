import os
from datetime import datetime, timezone, timedelta
from flask import Flask
from apscheduler.schedulers.background import BackgroundScheduler

from .extensions import db, migrate
from config.settings import config


def _scan_and_store(app: Flask) -> None:
    """Run a BLE scan and persist all discovered devices to the DB."""
    from .models import BLEDevice
    from .bluetooth.scanner import get_bluetooth_devices

    with app.app_context():
        try:
            devices = get_bluetooth_devices(timeout=app.config["BLE_SCAN_TIMEOUT"])
        except RuntimeError:
            return

        if not devices:
            return

        now = datetime.now(timezone.utc)
        db.session.add_all(
            [
                BLEDevice(
                    scanned_at=now,
                    address=d["address"],
                    name=d["name"],
                    rssi=d["rssi"],
                    tx_power=d["tx_power"],
                    estimated_distance_m=d["estimated_distance_m"],
                    signal_quality_pct=d["signal_quality_pct"],
                    path_loss_db=d["path_loss_db"],
                    address_type=d["address_type"],
                    is_apple=d["is_apple"],
                    is_microsoft=d["is_microsoft"],
                    known_companies=d["known_companies"],
                    device_profiles=d["device_profiles"],
                    service_uuids=list(d["service_uuids"]),
                    manufacturer_data=d["manufacturer_data"],
                    service_data=d["service_data"],
                )
                for d in devices
            ]
        )
        db.session.commit()


def _purge_old_devices(app: Flask) -> None:
    """Delete BLE scan records older than the configured retention window."""
    from .models import BLEDevice

    with app.app_context():
        retention = app.config["BLE_RETENTION_SECONDS"]
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=retention)
        BLEDevice.query.filter(BLEDevice.scanned_at < cutoff).delete()
        db.session.commit()


def create_app(config_name: str | None = None) -> Flask:
    if config_name is None:
        config_name = os.getenv("FLASK_ENV", "default")

    app = Flask(__name__)
    app.config.from_object(config[config_name])

    db.init_app(app)
    migrate.init_app(app, db)

    from . import models  # noqa: F401

    from .api.routes import api_bp
    app.register_blueprint(api_bp, url_prefix="/api")

    scheduler = BackgroundScheduler()
    scheduler.add_job(
        _scan_and_store,
        trigger="interval",
        seconds=app.config["BLE_SCAN_INTERVAL_SECONDS"],
        id="ble_scan",
        args=[app],
        max_instances=1,  # Never overlap scans
    )
    scheduler.add_job(
        _purge_old_devices,
        trigger="interval",
        seconds=app.config["PURGE_INTERVAL_SECONDS"],
        id="purge_ble_devices",
        args=[app],
    )
    scheduler.start()

    return app
