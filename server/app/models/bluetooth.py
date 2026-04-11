import time
from typing import Optional

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import db


class BluetoothDevice(db.Model):
    """One row per BLE MAC address; updated on every scan."""

    __tablename__ = "bluetooth_devices"

    address: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tx_power: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    address_type: Mapped[str] = mapped_column(String, default="public")
    is_apple: Mapped[bool] = mapped_column(Boolean, default=False)
    is_microsoft: Mapped[bool] = mapped_column(Boolean, default=False)
    known_companies: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    device_profiles: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    service_uuids: Mapped[Optional[list]] = mapped_column(JSON, default=list)
    manufacturer_data: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    service_data: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    last_seen_at: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)

    history: Mapped[list["BluetoothHistory"]] = relationship(
        back_populates="device",
        cascade="all, delete-orphan",
        order_by="BluetoothHistory.recorded_at",
    )


class BluetoothHistory(db.Model):
    """Time-series RSSI/distance readings per BLE device."""

    __tablename__ = "bluetooth_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    address: Mapped[str] = mapped_column(
        String, ForeignKey("bluetooth_devices.address", ondelete="CASCADE")
    )
    rssi: Mapped[int] = mapped_column(Integer)
    distance: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    recorded_at: Mapped[float] = mapped_column(Float, default=time.time)

    device: Mapped["BluetoothDevice"] = relationship(back_populates="history")

    __table_args__ = (
        Index("idx_bt_history_address", "address"),
        Index("idx_bt_history_recorded", "recorded_at"),
    )
