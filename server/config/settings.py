import os


class Config:
    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///radar.db")
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    BLE_SCAN_TIMEOUT = float(os.getenv("BLE_SCAN_TIMEOUT", 10.0))
    BLE_SCAN_INTERVAL_SECONDS = int(os.getenv("BLE_SCAN_INTERVAL_SECONDS", 15))
    BLE_RETENTION_SECONDS = int(os.getenv("BLE_RETENTION_SECONDS", 120))
    PURGE_INTERVAL_SECONDS = int(os.getenv("PURGE_INTERVAL_SECONDS", 30))


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


config = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "default": DevelopmentConfig,
}
