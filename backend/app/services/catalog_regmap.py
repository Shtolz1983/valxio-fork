"""The register-map chip for the QEMU worker (ESP32).

Python twin of frontend/src/partsCatalog/regmap.ts: a parts-catalog card
whose chip has no hand-written model describes it as a register file
(`"sim": {"model": "regmap", "regmap": {...}}`), fixed bytes plus readings
made from the panel values, and this engine answers the guest from that
description exactly as the tab's engine answers an Uno. Both answer the cases
in frontend/src/__tests__/fixtures/regmap-vectors.json.

The worker reaches it two ways: an I2C `catalog-i2c` record with model
'regmap' and the map in `regmap` (catalog_i2c_models.catalog_slave), and an SPI
bus-map entry naming catalog 'regmap' with the map in `model.regmap`
(catalog_spi_models.catalog_spi_runtime).
"""

from __future__ import annotations

import math
import re


def regmap_number(v) -> float:
    """A number as a card writes it: 12, "12", "0x0C". NaN when it is none."""
    if isinstance(v, bool):
        return math.nan
    if isinstance(v, (int, float)):
        return v
    if not isinstance(v, str):
        return math.nan
    s = v.strip()
    if re.fullmatch(r'0x[0-9a-fA-F]+', s):
        return int(s[2:], 16)
    if re.fullmatch(r'-?\d+(\.\d+)?', s):
        return float(s) if '.' in s else int(s)
    return math.nan


def _round(x: float) -> float:
    """JavaScript's Math.round: halves go up (Python's round() goes to even)."""
    if not math.isfinite(x):
        return x
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def regmap_interpolate(points, v: float) -> float:
    """A curve's output at `v`: linear between points, flat outside the ends."""
    if v <= points[0][0]:
        return points[0][1]
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        if v <= x1:
            return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0)
    return points[-1][1]


def regmap_bytes(val: dict, v: float) -> list:
    """The bytes a reading puts in its registers, in register order."""
    n = int(val.get('bytes', 1))
    shift = int(val.get('shift', 0))
    if val.get('points'):
        x = regmap_interpolate(val['points'], v)
    else:
        x = v * val.get('scale', 1) + val.get('offset', 0)
    bits = n * 8 - shift
    lo = -(2 ** (bits - 1)) if val.get('signed') else 0
    hi = 2 ** (bits - 1) - 1 if val.get('signed') else 2 ** bits - 1
    r = _round(x)
    r = 0 if not math.isfinite(r) else int(r)
    r = min(hi, max(lo, r))
    if r < 0:
        r += 2 ** bits
    word = r << shift
    orv = int(regmap_number(val.get('or', 0)))
    out = [((word >> (8 * i)) & 0xFF) | ((orv >> (8 * i)) & 0xFF) for i in range(n - 1, -1, -1)]
    return out[::-1] if val.get('order') == 'le' else out


class RegmapChip:
    """The chip. `values` are the panel's; set them before a read to change
    the reading. I2C: start/write_byte/read_byte/stop (catalog_i2c_models'
    _Device shape); SPI: select/deselect/transfer/peek_miso (_SpiChip's)."""

    def __init__(self, spec: dict):
        self.spec = spec or {}
        self.values: dict = {}
        self.pointer_bytes = int(self.spec.get('pointer', 1))
        self.width = 2 if self.spec.get('width') == 2 else 1
        # Byte cells: registers x width.
        self.space = (0x10000 if self.pointer_bytes == 2 else 0x100) * self.width
        self.image: dict = {}
        self.ptr = 0
        self.reg = 0
        self.addr_seen = 0
        self.first_raw = 0
        self.phase = 'idle'
        self.power_on()

    def power_on(self) -> None:
        self.image = {}
        for k, v in (self.spec.get('registers') or {}).items():
            a = int(regmap_number(k))
            for i, b in enumerate(v if isinstance(v, list) else [v]):
                self.image[(a * self.width + i) % self.space] = int(regmap_number(b)) & 0xFF
        self.ptr = 0
        self.phase = 'idle'

    def _snapshot(self) -> None:
        for val in self.spec.get('values') or []:
            v = self.values.get(val.get('from'))
            ok = isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            reg = int(regmap_number(val.get('reg')))
            for i, b in enumerate(regmap_bytes(val, v if ok else 0)):
                self.image[(reg * self.width + i) % self.space] = b

    def _next(self) -> int:
        """The cell under the pointer; the pointer moves on (within its
        register when width is 2)."""
        a = self.ptr
        base = a - (a % self.width)
        self.ptr = (a + 1) % self.space if self.width == 1 else base + ((a - base + 1) % self.width)
        return a

    def _take_address(self, byte: int) -> bool:
        self.reg = byte if self.addr_seen == 0 else (self.reg << 8) | byte
        self.addr_seen += 1
        self.ptr = (self.reg * self.width) % self.space
        return self.addr_seen >= self.pointer_bytes

    # ── I2C ──

    def start(self, read: bool) -> None:
        if read:
            self._snapshot()
            if self.pointer_bytes == 0:
                self.ptr = 0
            self.phase = 'read'
        else:
            self.addr_seen = 0
            self.phase = 'data' if self.pointer_bytes == 0 else 'addr'

    def write_byte(self, value: int) -> bool:
        b = value & 0xFF
        # A host that does not report START is followed from the bytes.
        if self.phase in ('idle', 'read'):
            self.start(False)
        if self.phase == 'addr':
            if self._take_address(b):
                self.phase = 'data'
        elif self.phase == 'data' and self.pointer_bytes > 0:
            self.image[self._next()] = b
        return True

    def read_byte(self) -> int:
        if self.phase != 'read':
            self.start(True)
        return self.image.get(self._next(), 0)

    def stop(self) -> None:
        self.phase = 'idle'

    # ── SPI ──

    def select(self) -> None:
        self.addr_seen = 0
        if self.pointer_bytes == 0:
            self._snapshot()
            self.ptr = 0
            self.phase = 'read'
        else:
            self.phase = 'addr'

    def deselect(self) -> None:
        self.phase = 'idle'

    def transfer(self, mosi: int) -> int:
        b = mosi & 0xFF
        if self.phase == 'addr':
            if self.addr_seen == 0:
                self.first_raw = b
            mask = int(regmap_number(self.spec.get('addressMask', 0x7F))) & 0xFF
            masked = b & mask if self.addr_seen == 0 else b
            if self._take_address(masked):
                read = (self.first_raw >> int(self.spec.get('readBit', 7))) & 1
                self.phase = 'read' if read == int(self.spec.get('readWhen', 1)) else 'write'
                if self.phase == 'read':
                    self._snapshot()
            return 0
        if self.phase == 'read':
            return self.image.get(self._next(), 0)
        if self.phase == 'write':
            self.image[self._next()] = b
        return 0

    def peek_miso(self) -> int:
        """The byte the next transfer answers, for a bit-banged master reading ahead."""
        return self.image.get(self.ptr, 0) if self.phase == 'read' else 0
