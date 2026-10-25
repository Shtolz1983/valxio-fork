"""Parts-catalog I2C chips for the QEMU worker (ESP32).

The canvas modules of the parts catalogue answer the bus from TypeScript
models in the tab (frontend/src/partsCatalog/simModels.ts and models/*.ts).
An ESP32 runs its firmware here, beside QEMU, and asks for every ACK and byte
synchronously, so the tab is too far away: these are Python twins of those
models, line for line, answering the same library traffic.

One worker record type carries them all: `catalog-i2c`, with `model` naming
the chip ('bh1750', 'aht20', 'sht31', 'bme280'), `addr`, and the panel's
values under the card's control keys (temperature, humidity, pressure, lux).

A model has the tab's I2CDevice shape — start(read), write_byte(b),
read_byte(), stop() — and CatalogI2cSlave turns the worker's bus events into
those calls, so a port reads like its original.
"""

from __future__ import annotations

import importlib
import importlib.util
import math
import pathlib
import struct
import sys

# The worker's bus events (esp32_i2c_slaves.py, picsimlab I2C callbacks).
I2C_START_RECV = 0x00
I2C_START_SEND = 0x01
I2C_FINISH = 0x03
I2C_WRITE = 0x05
I2C_READ = 0x06


def _num(value, default: float) -> float:
    """A finite number off a record field, else the default (the canvas may
    send numbers as strings)."""
    if isinstance(value, bool):
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def _round(x: float) -> int:
    """JavaScript's Math.round: halves go up (Python's round() goes to even)."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def crc8(data) -> int:
    """Sensirion / Aosong CRC-8: polynomial 0x31, init 0xFF."""
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


class _Device:
    """A model as the tab writes it; `values` are the panel's."""

    def __init__(self, address: int):
        self.address = address
        self.values: dict = {}

    def value(self, key: str, default: float) -> float:
        return _num(self.values.get(key), default)

    def start(self, read: bool) -> None:  # noqa: D401 - protocol hook
        pass

    def write_byte(self, value: int) -> bool:
        return True

    def read_byte(self) -> int:
        return 0xFF

    def stop(self) -> None:
        pass


class FrameDevice(_Device):
    """Answers every read from the start of a frame its last command chose
    (FrameDevice in simModels.ts)."""

    def __init__(self, address: int):
        super().__init__(address)
        self.command: list = []
        self._frame: list = []
        self._index = 0
        self._closed = True

    def frame_for(self) -> list:
        raise NotImplementedError

    def write_byte(self, value: int) -> bool:
        if self._closed:
            self.command = []
        self._closed = False
        self.command.append(value & 0xFF)
        self._index = 0
        return True

    def start(self, read: bool) -> None:
        self._closed = True
        if read:
            self._index = 0

    def read_byte(self) -> int:
        self._closed = True
        if self._index == 0:
            self._frame = self.frame_for()
        if self._index < len(self._frame):
            b = self._frame[self._index]
            self._index += 1
            return b
        return 0xFF

    def stop(self) -> None:
        self._closed = True
        self._index = 0


class Bh1750(FrameDevice):
    """BH1750: one opcode per write, a 16-bit big-endian count per read."""

    def __init__(self, address: int):
        super().__init__(address)
        self.mode = 0x10
        self.mtreg = 69

    def write_byte(self, value: int) -> bool:
        op = value & 0xFF
        if (op & 0xF8) == 0x40:
            self.mtreg = ((op & 0x07) << 5) | (self.mtreg & 0x1F)
        elif (op & 0xE0) == 0x60:
            self.mtreg = (self.mtreg & 0xE0) | (op & 0x1F)
        elif op in (0x10, 0x11, 0x13, 0x20, 0x21, 0x23):
            self.mode = op
        return super().write_byte(value)

    def frame_for(self) -> list:
        lux = self.value('lux', 0)
        hi_res2 = self.mode in (0x11, 0x21)
        raw = _round(_clamp(lux * 1.2 * (self.mtreg / 69) * (2 if hi_res2 else 1), 0, 0xFFFF))
        return [raw >> 8, raw & 0xFF]


class Aht20(FrameDevice):
    """AHT20: a status byte (calibrated, never busy), then 20-bit humidity and
    temperature, then CRC."""

    def frame_for(self) -> list:
        status = 0x18
        if not self.command or self.command[0] != 0xAC:
            return [status]
        h = _round(_clamp(self.value('humidity', 50) / 100, 0, 1) * 0xFFFFF)
        t = _round(_clamp((self.value('temperature', 24) + 50) / 200, 0, 1) * 0xFFFFF)
        data = [status, (h >> 12) & 0xFF, (h >> 4) & 0xFF, ((h & 0x0F) << 4) | ((t >> 16) & 0x0F),
                (t >> 8) & 0xFF, t & 0xFF]
        return data + [crc8(data)]


class Sht31(FrameDevice):
    """SHT3x: 16-bit commands; a measurement reads T, CRC, RH, CRC; the status
    register reads 0x0000."""

    def frame_for(self) -> list:
        cmd = ((self.command[0] if self.command else 0) << 8) | (self.command[1] if len(self.command) > 1 else 0)

        def word(v: int) -> list:
            b = [(v >> 8) & 0xFF, v & 0xFF]
            return b + [crc8(b)]

        if cmd == 0xF32D:
            return word(0)
        t = _round(_clamp((self.value('temperature', 24) + 45) / 175, 0, 1) * 0xFFFF)
        h = _round(_clamp(self.value('humidity', 50) / 100, 0, 1) * 0xFFFF)
        return word(t) + word(h)


# ── BME280 ──────────────────────────────────────────────────────────────────


def _tdiv(a: int, b: int) -> int:
    """C integer division: truncates toward zero."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def _i32(x: int) -> int:
    """C int32 wrap-around."""
    return ((x + 0x80000000) % 0x100000000) - 0x80000000


def _f32(x: float) -> float:
    return struct.unpack('f', struct.pack('f', x))[0]


def invert_monotonic(fn, target: float, lo: int, hi: int, falling: bool = False) -> int:
    """The integer in [lo, hi] whose fn is closest to target, fn monotonic."""
    g = (lambda x: -fn(x)) if falling else fn
    t = -target if falling else target
    a, b = lo, hi
    while a < b:
        mid = (a + b) // 2
        if g(mid) < t:
            a = mid + 1
        else:
            b = mid
    if a > lo and abs(g(a - 1) - t) <= abs(g(a) - t):
        return a - 1
    return a


# BMP280 datasheet example T/P trimming (as VirtualBMP280), typical humidity trimming.
_CAL = dict(T1=27504, T2=26435, T3=-1000,
            P1=36477, P2=-10685, P3=3024, P4=2855, P5=140, P6=-7, P7=15500, P8=-14600, P9=6000,
            H1=75, H2=362, H3=0, H4=313, H5=50, H6=30)

_ID, _RESET, _CTRL_HUM, _STATUS, _CTRL_MEAS, _CONFIG, _DATA = 0xD0, 0xE0, 0xF2, 0xF3, 0xF4, 0xF5, 0xF7


def bme280_t_fine(adc_t: int) -> int:
    c = _CAL
    var1 = _tdiv(adc_t, 8) - c['T1'] * 2
    var1 = _tdiv(_i32(var1 * c['T2']), 2048)
    var2 = _tdiv(adc_t, 16) - c['T1']
    var2 = _tdiv(_i32(_tdiv(_i32(var2 * var2), 4096) * c['T3']), 16384)
    return var1 + var2


def bme280_pressure(adc_p: int, t_fine: int) -> float:
    """Adafruit_BME280::readPressure (int64 path), in Pa."""
    c = _CAL
    var1 = t_fine - 128000
    var2 = var1 * var1 * c['P6']
    var2 = var2 + var1 * c['P5'] * 131072
    var2 = var2 + c['P4'] * 34359738368
    var1 = _tdiv(var1 * var1 * c['P3'], 256) + var1 * c['P2'] * 4096
    var3 = 140737488355328
    var1 = _tdiv((var3 + var1) * c['P1'], 8589934592)
    if var1 == 0:
        return 0.0
    var4 = 1048576 - adc_p
    var4 = _tdiv((var4 * 2147483648 - var2) * 3125, var1)
    var1 = _tdiv(c['P9'] * _tdiv(var4, 8192) * _tdiv(var4, 8192), 33554432)
    var2 = _tdiv(c['P8'] * var4, 524288)
    var4 = _tdiv(var4 + var1 + var2, 256) + c['P7'] * 16
    return _f32(float(var4)) / 256


def bme280_humidity(adc_h: int, t_fine: int) -> float:
    """Adafruit_BME280::readHumidity (C int32 arithmetic), in %."""
    c = _CAL
    var1 = t_fine - 76800
    var2 = _i32(adc_h * 16384)
    var3 = _i32(c['H4'] * 1048576)
    var4 = _i32(c['H5'] * var1)
    var5 = _tdiv(_i32(var2 - var3 - var4 + 16384), 32768)
    var2 = _tdiv(_i32(var1 * c['H6']), 1024)
    var3 = _tdiv(_i32(var1 * c['H3']), 2048)
    var4 = _tdiv(_i32(var2 * (var3 + 32768)), 1024) + 2097152
    var2 = _tdiv(_i32(var4 * c['H2'] + 8192), 16384)
    var3 = _i32(var5 * var2)
    var4 = _tdiv(_i32(_tdiv(var3, 32768) * _tdiv(var3, 32768)), 128)
    var5 = var3 - _tdiv(_i32(var4 * c['H1']), 16)
    var5 = int(_clamp(var5, 0, 419430400))
    return (var5 >> 12) / 1024


def _adc20(v: int) -> list:
    return [(v >> 12) & 0xFF, (v >> 4) & 0xFF, (v & 0x0F) << 4]


class Bme280(_Device):
    """BME280 as Adafruit BME280 Library reads it (Bme280Model in bosch.ts):
    chip id 0x60, soft reset, status bit 0 clear, T/P trimming at 0x88-0x9F
    and humidity trimming at 0xA1 and 0xE1-0xE7, ctrl_hum taking effect at the
    next ctrl_meas write, forced mode measuring once with `measuring` seen
    once, normal mode measuring at the start of every read."""

    def __init__(self, address: int):
        super().__init__(address)
        self.regs = bytearray(256)
        self._pointer = 0
        self._first_byte = True
        self._latch_due = True
        self._osrs_h = 0
        self._measuring = False
        self._memo_key = None
        self._memo = None
        self._write_calibration()
        self._power_on()

    def _write_calibration(self) -> None:
        c, r = _CAL, self.regs

        def le(a: int, v: int) -> None:
            r[a] = v & 0xFF
            r[a + 1] = (v >> 8) & 0xFF

        for i, k in enumerate(('T1', 'T2', 'T3', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9')):
            le(0x88 + 2 * i, c[k])
        r[0xA1] = c['H1']
        le(0xE1, c['H2'])
        r[0xE3] = c['H3']
        r[0xE4] = (c['H4'] >> 4) & 0xFF
        r[0xE5] = ((c['H5'] & 0x0F) << 4) | (c['H4'] & 0x0F)
        r[0xE6] = (c['H5'] >> 4) & 0xFF
        r[0xE7] = c['H6'] & 0xFF

    def _power_on(self) -> None:
        r = self.regs
        r[_ID] = 0x60
        r[_CTRL_HUM] = r[_STATUS] = r[_CTRL_MEAS] = r[_CONFIG] = 0
        r[_DATA:_DATA + 8] = bytes([0x80, 0, 0, 0x80, 0, 0, 0x80, 0])
        self._osrs_h = 0
        self._measuring = False

    @property
    def _mode(self) -> int:
        return self.regs[_CTRL_MEAS] & 0x03

    def _adc_words(self) -> tuple:
        T = self.value('temperature', 24)
        H = self.value('humidity', 50)
        P = self.value('pressure', 1013.25)
        key = (T, H, P)
        if key != self._memo_key:
            centi = _round(T * 100)
            t = invert_monotonic(lambda a: _tdiv(bme280_t_fine(a) * 5 + 128, 256), centi, 0, 0xFFFFF)
            tf = bme280_t_fine(t)
            p = invert_monotonic(lambda a: bme280_pressure(a, tf), P * 100, 0, 0xFFFFF, falling=True)
            h = invert_monotonic(lambda a: bme280_humidity(a, tf), _clamp(H, 0, 100), 0, 0xFFFF)
            self._memo_key, self._memo = key, (t, p, h)
        return self._memo

    def _measure(self, ctrl_meas: int) -> None:
        osrs_t = (ctrl_meas >> 5) & 7
        osrs_p = (ctrl_meas >> 2) & 7
        t, p, h = self._adc_words()
        press = _adc20(p) if osrs_p else [0x80, 0, 0]
        temp = _adc20(t) if osrs_t else [0x80, 0, 0]
        hum = [(h >> 8) & 0xFF, h & 0xFF] if self._osrs_h else [0x80, 0]
        self.regs[_DATA:_DATA + 8] = bytes(press + temp + hum)

    def _latch(self) -> None:
        if self._mode == 3:
            self._measure(self.regs[_CTRL_MEAS])

    def start(self, read: bool) -> None:
        if read:
            self._latch()
            self._latch_due = False

    def write_byte(self, value: int) -> bool:
        self._latch_due = True
        if self._first_byte:
            self._pointer = value & 0xFF
            self._first_byte = False
            return True
        self._first_byte = True
        self._write_register(self._pointer, value & 0xFF)
        return True

    def read_byte(self) -> int:
        if self._latch_due:
            self._latch()
            self._latch_due = False
        reg = self._pointer
        self._pointer = (reg + 1) & 0xFF
        if reg == _STATUS:
            status = 0x08 if self._measuring else 0
            self._measuring = False
            return status
        return self.regs[reg]

    def stop(self) -> None:
        self._first_byte = True
        self._latch_due = True

    def _write_register(self, reg: int, value: int) -> None:
        if reg == _RESET:
            if value == 0xB6:
                self._power_on()
            return
        if reg == _CTRL_HUM:
            self.regs[reg] = value & 0x07
            return
        if reg == _CONFIG:
            self.regs[reg] = value
            return
        if reg != _CTRL_MEAS:
            return
        self._osrs_h = self.regs[_CTRL_HUM] & 0x07
        mode = value & 0x03
        if mode == 0:
            if self._mode == 3:
                self._measure(self.regs[reg])
            self._measuring = False
            self.regs[reg] = value
            return
        self._measuring = True
        if mode == 3:
            self.regs[reg] = value
            return
        self._measure(value)
        self.regs[reg] = value & ~0x03 & 0xFF


MODELS = {'bh1750': Bh1750, 'aht20': Aht20, 'sht31': Sht31, 'bme280': Bme280}


def _load_family(name: str):
    """A sibling module of more models (catalog_i2c_simple.py, ...). The worker
    loads this file by path when `app.services` is not importable, so the
    sibling is found the same two ways."""
    try:
        return importlib.import_module(f'app.services.{name}')
    except ImportError:
        pass
    if name in sys.modules:
        return sys.modules[name]
    path = pathlib.Path(__file__).parent / f'{name}.py'
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# Each family module exports MODELS: {name: class}. A class whose models keep
# time (a conversion period, a sample rate) sets `uses_clock = True` and takes
# `now_ns`: the guest's clock in ns (a callable), or None when the worker has
# none; such a model then answers as if every period had already elapsed.
for _family in ('catalog_i2c_simple', 'catalog_i2c_bosch', 'catalog_i2c_complex'):
    _mod = _load_family(_family)
    if _mod is not None:
        MODELS.update(getattr(_mod, 'MODELS', {}))

# Record fields that are not panel values.
_NOT_VALUES = {'cmd', 'pin', 'sensor_type', 'type', 'model', 'addr', 'owner', 'line_request', 'component_id', 'regmap'}


class CatalogI2cSlave:
    """A catalog model on the worker's bus table: bus events in, model calls out."""

    def __init__(self, model: _Device):
        self.model = model
        self.addr = model.address

    def update(self, **inputs) -> None:
        """The panel moved: every finite number the update names is a value."""
        for k, v in inputs.items():
            if k in _NOT_VALUES or isinstance(v, bool):
                continue
            n = _num(v, float('nan'))
            if math.isfinite(n):
                self.model.values[k] = n

    def inputs(self) -> dict:
        return dict(self.model.values)

    def handle_event(self, event: int) -> int:
        op = event & 0xFF
        data = (event >> 8) & 0xFF
        if op == I2C_START_RECV:
            self.model.start(True)
            return 0
        if op == I2C_START_SEND:
            self.model.start(False)
            return 0
        if op == I2C_WRITE:
            self.model.write_byte(data)
            return 0
        if op == I2C_READ:
            return self.model.read_byte() & 0xFF
        # I2C_FINISH, I2C_NACK, unknown.
        self.model.stop()
        return 0


def catalog_slave(record: dict, now_ns=None) -> CatalogI2cSlave | None:
    """The slave a `catalog-i2c` record asks for, or None for a model this
    worker does not have (the record is then taken and nothing answers).
    `now_ns`: the guest clock, for models that keep time. Model 'regmap' is
    the card's own register map (catalog_regmap.py), carried in `regmap`."""
    addr = int(_num(record.get('addr'), 0)) & 0x7F
    if record.get('model') == 'regmap':
        regmap = _load_family('catalog_regmap')
        if regmap is None or not isinstance(record.get('regmap'), dict):
            return None
        model = regmap.RegmapChip(record['regmap'])
        model.address = addr
    else:
        cls = MODELS.get(str(record.get('model', '')))
        if cls is None:
            return None
        model = cls(addr, now_ns=now_ns) if getattr(cls, 'uses_clock', False) else cls(addr)
    slave = CatalogI2cSlave(model)
    slave.update(**record)
    return slave
