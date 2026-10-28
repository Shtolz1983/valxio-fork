"""Catalog of battery packs a compartment can be made for: the outer size of a common holder (or of the cell
itself when it is used without one). Nominal sizes from typical holders, not measured."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BatteryType:
    length: float
    width: float
    height: float
    description: str


CATALOG: dict[str, BatteryType] = {
    "2xAA": BatteryType(58.0, 32.0, 16.0, "2 x AA side-by-side holder, 3 V"),
    "4xAA": BatteryType(62.0, 58.0, 16.0, "4 x AA flat holder, 6 V"),
    "1x18650": BatteryType(77.0, 21.0, 20.0, "1 x 18650 holder, 3.7 V"),
    "2x18650": BatteryType(77.0, 41.0, 20.0, "2 x 18650 holder, 3.7 V parallel or 7.4 V series"),
    "9V": BatteryType(55.0, 27.0, 18.0, "9 V PP3 battery with its snap clip"),
    "lipo_503450": BatteryType(52.0, 35.0, 6.0, "flat LiPo 503450, 1000 mAh, 3.7 V"),
}
