import time
from typing import Optional

from sqlalchemy import Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import db


class WifiDevice(db.Model):
    """One row per WiFi BSSID; updated on every scan."""

    __tablename__ = "wifi_devices"

    bssid: Mapped[str] = mapped_column(String, primary_key=True)
    ssid: Mapped[str] = mapped_column(String, default="Hidden")
    frequency_mhz: Mapped[int] = mapped_column(Integer, default=0)
    channel: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    band: Mapped[str] = mapped_column(String, default="2.4 GHz")
    security: Mapped[str] = mapped_column(String, default="Open")
    vendor: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    last_seen_at: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)

    history: Mapped[list["WifiHistory"]] = relationship(
        back_populates="device",
        cascade="all, delete-orphan",
        order_by="WifiHistory.recorded_at",
    )


class WifiHistory(db.Model):
    """Time-series RSSI/distance readings per WiFi access point."""

    __tablename__ = "wifi_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bssid: Mapped[str] = mapped_column(
        String, ForeignKey("wifi_devices.bssid", ondelete="CASCADE")
    )
    rssi: Mapped[int] = mapped_column(Integer)
    distance: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    recorded_at: Mapped[float] = mapped_column(Float, default=time.time)

    device: Mapped["WifiDevice"] = relationship(back_populates="history")

    __table_args__ = (
        Index("idx_wifi_history_bssid", "bssid"),
        Index("idx_wifi_history_recorded", "recorded_at"),
    )
