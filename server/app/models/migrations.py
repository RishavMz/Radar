"""
Idempotent schema migrations for the Radar DB.

Called once at app startup (after db.create_all()).  Each ALTER TABLE is
guarded by a column-existence check so re-running on an already-migrated DB
is always a no-op.
"""

from sqlalchemy import text

# (table, new_column, ALTER TABLE statement)
_DDL = [
    # bluetooth_history
    ("bluetooth_history", "smoothed_rssi",
     "ALTER TABLE bluetooth_history ADD COLUMN smoothed_rssi FLOAT"),
    ("bluetooth_history", "is_outlier",
     "ALTER TABLE bluetooth_history ADD COLUMN is_outlier BOOLEAN NOT NULL DEFAULT 0"),
    # wifi_history
    ("wifi_history", "smoothed_rssi",
     "ALTER TABLE wifi_history ADD COLUMN smoothed_rssi FLOAT"),
    ("wifi_history", "is_outlier",
     "ALTER TABLE wifi_history ADD COLUMN is_outlier BOOLEAN NOT NULL DEFAULT 0"),
    # bluetooth_devices
    ("bluetooth_devices", "smoothed_speed",
     "ALTER TABLE bluetooth_devices ADD COLUMN smoothed_speed FLOAT"),
    ("bluetooth_devices", "movement_state",
     "ALTER TABLE bluetooth_devices ADD COLUMN movement_state VARCHAR"),
    ("bluetooth_devices", "movement_since",
     "ALTER TABLE bluetooth_devices ADD COLUMN movement_since FLOAT"),
    # wifi_devices
    ("wifi_devices", "smoothed_speed",
     "ALTER TABLE wifi_devices ADD COLUMN smoothed_speed FLOAT"),
    ("wifi_devices", "movement_state",
     "ALTER TABLE wifi_devices ADD COLUMN movement_state VARCHAR"),
    ("wifi_devices", "movement_since",
     "ALTER TABLE wifi_devices ADD COLUMN movement_since FLOAT"),
]


def _column_names(conn, table: str) -> set:
    rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    return {r[1] for r in rows}


def migrate_db(engine) -> None:
    """Apply any missing schema additions; safe to call on every startup."""
    with engine.connect() as conn:
        existing = {t: _column_names(conn, t) for t in {row[0] for row in _DDL}}
        for table, col, stmt in _DDL:
            if col not in existing.get(table, set()):
                conn.execute(text(stmt))
        conn.commit()
