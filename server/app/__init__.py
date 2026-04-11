from flask import Flask, redirect, render_template, url_for

from .config import DB_DIR, Config
from .models import db


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)

    # Ensure the db/ directory exists before SQLAlchemy tries to create the file.
    DB_DIR.mkdir(parents=True, exist_ok=True)

    db.init_app(app)

    with app.app_context():
        # Import models so SQLAlchemy registers them before create_all().
        from .models import bluetooth  # noqa: F401
        from .models import wifi       # noqa: F401
        db.create_all()

    # Register blueprints.
    from .api.bluetooth import bluetooth_bp
    from .api.wifi import wifi_bp

    app.register_blueprint(bluetooth_bp, url_prefix="/api/bluetooth")
    app.register_blueprint(wifi_bp,      url_prefix="/api/wifi")

    # Dashboard routes.
    @app.get("/")
    def index():
        return redirect(url_for("bluetooth_dashboard"))

    @app.get("/dashboard/bluetooth")
    def bluetooth_dashboard():
        return render_template("bluetooth.html")

    @app.get("/dashboard/wifi")
    def wifi_dashboard():
        return render_template("wifi.html")

    return app
