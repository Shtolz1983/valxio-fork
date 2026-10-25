"""Bosch catalog chips for the QEMU worker (ESP32): BMP180 and BME680.

Python twins of Bmp180Model and Bme680Model in
frontend/src/partsCatalog/models/bosch.ts, line for line (the BME280 twin is
in catalog_i2c_models.py, whose helpers these share). Each holds a
calibration block chosen there, and a measurement puts in the data registers
the raw ADC words that the card's library turns back into the panel's values:
the driver's own compensation run backwards by a search over the ADC word.
catalog_i2c_models.py loads this module and merges its MODELS.

Common to both, as on the chip: a write is pairs of register address and data
(the address does not count up), a read counts up from the last address
written; the soft reset word 0xB6 at 0xE0 puts the control and data registers
back, the calibration survives; a conversion takes no time. JavaScript's
int32 operators (`>>`, `<<`, `|0`) and Math.fround are spelled out (_sar,
_shl, _i32, _f32) so every intermediate wraps and rounds where the tab's does.
"""

from __future__ import annotations

import math

try:  # imported as app.services.catalog_i2c_bosch
    from app.services import catalog_i2c_models as _models
except ImportError:  # loaded by path beside catalog_i2c_models (the worker's fallback)
    import catalog_i2c_models as _models  # type: ignore[no-redef]

_adc20, _clamp, _Device, _f32 = _models._adc20, _models._clamp, _models._Device, _models._f32
_i32, _round, _tdiv, invert_monotonic = _models._i32, _models._round, _models._tdiv, _models.invert_monotonic


def _sar(x: int, n: int) -> int:
    """JavaScript `x >> n`: x taken as int32 first."""
    return _i32(x) >> n


def _shl(x: int, n: int) -> int:
    """JavaScript `x << n`: int32 in, int32 out."""
    return _i32(_i32(x) << n)


def _u32(x: int) -> int:
    return x % 0x100000000


def _js_i32(x: float) -> int:
    """JavaScript ToInt32 of a double (NaN and infinities give 0)."""
    if not math.isfinite(x):
        return 0
    return _i32(int(x))


class _BoschRegisterDevice(_Device):
    """A Bosch register file on I2C: pairs written, auto-increment read, and a
    `latch` hook at the start of every read (BoschRegisterDevice in bosch.ts)."""

    def __init__(self, address: int):
        super().__init__(address)
        self.regs = bytearray(256)
        self._pointer = 0
        self._first_byte = True
        self._latch_due = True

    def start(self, read: bool) -> None:
        if read:
            self.latch()
            self._latch_due = False

    def write_byte(self, value: int) -> bool:
        self._latch_due = True
        if self._first_byte:
            self._pointer = value & 0xFF
            self._first_byte = False
            return True
        self._first_byte = True
        self.write_register(self._pointer, value & 0xFF)
        return True

    def read_byte(self) -> int:
        if self._latch_due:
            self.latch()
            self._latch_due = False
        reg = self._pointer
        self._pointer = (reg + 1) & 0xFF
        return self.read_register(reg)

    def stop(self) -> None:
        self._first_byte = True
        self._latch_due = True

    def latch(self) -> None:
        """A read begins."""

    def read_register(self, reg: int) -> int:
        return self.regs[reg]

    def write_register(self, reg: int, value: int) -> None:
        raise NotImplementedError


# ── BMP180 ──────────────────────────────────────────────────────────────────

# BMP180 datasheet example calibration (BST-BMP180-DS000, 3.5).
_BMP180_CAL = dict(AC1=408, AC2=-72, AC3=-14383, AC4=32741, AC5=32757, AC6=23153,
                   B1=6190, B2=4, MB=-32768, MC=-8711, MD=2868)


def bmp180_b5(ut: int) -> int:
    """Adafruit_BMP085::computeB5."""
    c = _BMP180_CAL
    x1 = _sar((ut - c['AC6']) * c['AC5'], 15)
    x2 = _tdiv(c['MC'] * 2048, x1 + c['MD'])
    return x1 + x2


def bmp180_tenths(ut: int) -> int:
    """Adafruit_BMP085::readTemperature, in 0.1 degC."""
    return _sar(bmp180_b5(ut) + 8, 4)


def bmp180_pressure(up: int, ut: int, oss: int) -> int:
    """Adafruit_BMP085::readPressure, in Pa (C int32 / uint32 arithmetic)."""
    c = _BMP180_CAL
    b5 = bmp180_b5(ut)
    b6 = b5 - 4000
    x1 = _sar(c['B2'] * _sar(b6 * b6, 12), 11)
    x2 = _sar(c['AC2'] * b6, 11)
    x3 = x1 + x2
    b3 = _tdiv(_shl(c['AC1'] * 4 + x3, oss) + 2, 4)
    x1 = _sar(c['AC3'] * b6, 13)
    x2 = _sar(c['B1'] * _sar(b6 * b6, 12), 16)
    x3 = _sar(x1 + x2 + 2, 2)
    b4 = _u32(c['AC4'] * _u32(x3 + 32768)) // 32768
    b7 = _u32(_u32(up - b3) * (50000 >> oss))
    if b4 == 0:
        p = 0  # JavaScript: x / 0 is Infinity or NaN, ToInt32 of either 0
    else:
        p = math.floor((b7 * 2) / b4) if b7 < 0x80000000 else math.floor(b7 / b4) * 2
        p = _i32(p)
    x1 = _sar(p, 8) * _sar(p, 8)
    # A product past 2^53 is a rounded double in JavaScript before ToInt32.
    x1 = _sar(_js_i32(float(x1) * 3038), 16)
    x2 = _sar(-7357 * p, 16)
    return p + _sar(x1 + x2 + 3791, 4)


def _bmp180_ut_min() -> int:
    """The lowest UT with X1 + MD > 0: below it B5 is not monotonic (the datasheet's division)."""
    c = _BMP180_CAL
    ut = c['AC6']
    while _sar((ut - 1 - c['AC6']) * c['AC5'], 15) + c['MD'] > 0:
        ut -= 1
    return ut


_BMP180_UT_MIN = _bmp180_ut_min()


class Bmp180(_BoschRegisterDevice):
    """BMP180 (BMP085 protocol) as Adafruit BMP085 Library reads it (Bmp180Model):
    chip id 0x55 at 0xD0, eleven big-endian calibration words at 0xAA-0xBF, a
    command written to 0xF4 (0x2E temperature, 0x34 + (oss << 6) pressure)
    and the result at 0xF6-0xF8: UT as 16 bits, UP << (8 - oss) in 24 bits.
    The conversion is done at once, so sco (bit 5 of 0xF4) reads clear."""

    def __init__(self, address: int):
        super().__init__(address)
        c = _BMP180_CAL
        for i, k in enumerate(('AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'B1', 'B2', 'MB', 'MC', 'MD')):
            self.regs[0xAA + 2 * i] = (c[k] >> 8) & 0xFF
            self.regs[0xAB + 2 * i] = c[k] & 0xFF
        self._memo_t = (None, 0)
        self._memo_p = (None, 0)
        self._power_on()

    def _power_on(self) -> None:
        self.regs[0xD0] = 0x55
        self.regs[0xF4] = 0
        self.regs[0xF6:0xF9] = bytes([0x80, 0, 0])

    def _ut(self) -> int:
        T = self.value('temperature', 24)
        if self._memo_t[0] != T:
            self._memo_t = (T, invert_monotonic(bmp180_tenths, _round(T * 10), _BMP180_UT_MIN, 0xFFFF))
        return self._memo_t[1]

    def _up(self, oss: int) -> int:
        P = self.value('pressure', 1013.25)
        ut = self._ut()
        key = (ut, P, oss)
        if self._memo_p[0] != key:
            up = invert_monotonic(lambda a: bmp180_pressure(a, ut, oss), _round(P * 100), 0, (1 << (16 + oss)) - 1)
            self._memo_p = (key, up)
        return self._memo_p[1]

    def write_register(self, reg: int, value: int) -> None:
        if reg == 0xE0:
            if value == 0xB6:
                self._power_on()
            return
        if reg != 0xF4:
            return
        if value == 0x2E:
            ut = self._ut()
            self.regs[0xF6:0xF8] = bytes([(ut >> 8) & 0xFF, ut & 0xFF])
        elif (value & 0x3F) == 0x34:
            oss = value >> 6
            raw = self._up(oss) << (8 - oss)
            self.regs[0xF6:0xF9] = bytes([(raw >> 16) & 0xFF, (raw >> 8) & 0xFF, raw & 0xFF])
        self.regs[reg] = value & ~0x20 & 0xFF


# ── BME680 ──────────────────────────────────────────────────────────────────

# Trimming of a typical BME680 (values seen on production parts).
_BME680_CAL = dict(T1=26041, T2=26170, T3=3,
                   P1=36174, P2=-10335, P3=88, P4=7166, P5=-144, P6=30, P7=41, P8=-3127, P9=-2600, P10=30,
                   H1=790, H2=1007, H3=0, H4=45, H5=20, H6=120, H7=-100,
                   GH1=-30, GH2=-12000, GH3=18,
                   RES_HEAT_VAL=41, RES_HEAT_RANGE=1, RANGE_SW_ERR=0)

f = _f32


def bme680_temperature(adc: int) -> tuple:
    """bme68x.c (float path, BME68X_USE_FPU) calc_temperature: (degC, t_fine)."""
    c = _BME680_CAL
    a = f(adc)
    var1 = f(f(f(a / 16384) - f(c['T1'] / 1024)) * c['T2'])
    d = f(f(a / 131072) - f(c['T1'] / 8192))
    var2 = f(f(d * d) * f(c['T3'] * 16))
    t_fine = f(var1 + var2)
    return f(t_fine / 5120), t_fine


def bme680_pressure(adc: int, t_fine: float) -> float:
    """bme68x.c calc_pressure (float), in Pa."""
    c = _BME680_CAL
    var1 = f(f(t_fine / 2) - 64000)
    var2 = f(f(var1 * var1) * f(c['P6'] / 131072))
    var2 = f(var2 + f(f(var1 * c['P5']) * 2))
    var2 = f(f(var2 / 4) + f(c['P4'] * 65536))
    var1 = f(f(f(f(f(c['P3'] * var1) * var1) / 16384) + f(c['P2'] * var1)) / 524288)
    var1 = f(f(1 + f(var1 / 32768)) * c['P1'])
    p = f(1048576 - adc)
    if int(var1) == 0:
        return 0.0
    p = f(f(f(p - f(var2 / 4096)) * 6250) / var1)
    var1 = f(f(f(c['P9'] * p) * p) / 2147483648)
    var2 = f(p * f(c['P8'] / 32768))
    q = f(p / 256)
    var3 = f(f(f(q * q) * q) * f(c['P10'] / 131072))
    return f(p + f(f(f(f(var1 + var2) + var3) + f(c['P7'] * 128)) / 16))


def bme680_humidity(adc: int, t_fine: float) -> float:
    """bme68x.c calc_humidity (float), in %."""
    c = _BME680_CAL
    tc = f(t_fine / 5120)
    var1 = f(adc - f(f(c['H1'] * 16) + f(f(c['H3'] / 2) * tc)))
    k = f(f(1 + f(f(c['H4'] / 16384) * tc)) + f(f(f(c['H5'] / 1048576) * tc) * tc))
    var2 = f(var1 * f(f(c['H2'] / 262144) * k))
    var3 = f(c['H6'] / 16384)
    var4 = f(c['H7'] / 2097152)
    h = f(var2 + f(f(f(var3 + f(var4 * tc)) * var2) * var2))
    return _clamp(h, 0, 100)


_K1 = [f(v) for v in (0, 0, 0, 0, 0, -1, 0, -0.8, 0, 0, -0.2, -0.5, 0, -1, 0, 0)]
_K2 = [f(v) for v in (0, 0, 0, 0, 0.1, 0.7, 0, -0.8, -0.1, 0, 0, 0, 0, 0, 0, 0)]


def bme680_gas_low(adc: int, rng: int) -> float:
    """bme68x.c calc_gas_resistance_low (the BME680, variant 0), in ohm."""
    var1 = f(1340 + f(5 * _BME680_CAL['RANGE_SW_ERR']))
    var2 = f(var1 * f(1 + f(_K1[rng] / 100)))
    var3 = f(1 + f(_K2[rng] / 100))
    den = f(f(f(var3 * f(0.000000125)) * (1 << rng)) * f(f(f(adc - 512) / var2) + 1))
    return f(1 / den) if den else math.inf


def _bme680_humidity_zero(t_fine: float) -> float:
    """The humidity ADC word where bme68x's var1 is 0: below it the curve folds back."""
    c = _BME680_CAL
    return c['H1'] * 16 + (c['H3'] / 2) * (t_fine / 5120)


_FIELD0, _CTRL_GAS_0, _CTRL_GAS_1, _CTRL_HUM, _CTRL_MEAS = 0x1D, 0x70, 0x71, 0x72, 0x74
_ID, _RESET, _VARIANT = 0xD0, 0xE0, 0xF0


class Bme680(_BoschRegisterDevice):
    """BME680 as Adafruit BME680 Library (Bosch bme68x driver, float path)
    reads it (Bme680Model): chip id 0x61, variant 0x00 (gas low), the three
    calibration blocks 0x8A-0xA0, 0xE1-0xEE and 0x00-0x04 in the driver's
    layout; writes to 0x50-0x75 kept. A forced-mode write to ctrl_meas
    measures at once into field 0 (0x1D-0x2D): new_data, meas_index, T/P/H
    words, and with run_gas a gas word and range with gas_valid (heat_stab
    while the heater is on); the mode bits read sleep again. ctrl_hum takes
    effect at the ctrl_meas write; a skipped channel reads its reset value."""

    def __init__(self, address: int):
        super().__init__(address)
        self._osrs_h = 0
        self._meas_index = 0
        self._memo = (None, None)
        self._memo_gas = (None, None)
        self._write_calibration()
        self._power_on()

    def _write_calibration(self) -> None:
        c, r = _BME680_CAL, self.regs

        def le(a: int, v: int) -> None:
            r[a] = v & 0xFF
            r[a + 1] = (v >> 8) & 0xFF

        le(0x8A, c['T2'])
        r[0x8C] = c['T3'] & 0xFF
        le(0x8E, c['P1'])
        le(0x90, c['P2'])
        r[0x92] = c['P3'] & 0xFF
        le(0x94, c['P4'])
        le(0x96, c['P5'])
        r[0x98] = c['P7'] & 0xFF
        r[0x99] = c['P6'] & 0xFF
        le(0x9C, c['P8'])
        le(0x9E, c['P9'])
        r[0xA0] = c['P10'] & 0xFF
        r[0xE1] = (c['H2'] >> 4) & 0xFF
        r[0xE2] = ((c['H2'] & 0x0F) << 4) | (c['H1'] & 0x0F)
        r[0xE3] = (c['H1'] >> 4) & 0xFF
        r[0xE4] = c['H3'] & 0xFF
        r[0xE5] = c['H4'] & 0xFF
        r[0xE6] = c['H5'] & 0xFF
        r[0xE7] = c['H6'] & 0xFF
        r[0xE8] = c['H7'] & 0xFF
        le(0xE9, c['T1'])
        le(0xEB, c['GH2'])
        r[0xED] = c['GH1'] & 0xFF
        r[0xEE] = c['GH3'] & 0xFF
        r[0x00] = c['RES_HEAT_VAL'] & 0xFF
        r[0x02] = (c['RES_HEAT_RANGE'] & 0x03) << 4
        r[0x04] = (c['RANGE_SW_ERR'] & 0x0F) << 4

    def _power_on(self) -> None:
        r = self.regs
        r[0x50:0x76] = bytes(0x76 - 0x50)
        r[_FIELD0:_FIELD0 + 17] = bytes(17)
        r[_FIELD0 + 2:_FIELD0 + 10] = bytes([0x80, 0, 0, 0x80, 0, 0, 0x80, 0])
        r[_ID] = 0x61
        r[_VARIANT] = 0x00
        self._osrs_h = 0
        self._meas_index = 0

    def _adc_words(self) -> tuple:
        T = self.value('temperature', 24)
        H = self.value('humidity', 50)
        P = self.value('pressure', 1013.25)
        key = (T, H, P)
        if self._memo[0] != key:
            t = invert_monotonic(lambda a: bme680_temperature(a)[0], T, 0, 0xFFFFF)
            tf = bme680_temperature(t)[1]
            p = invert_monotonic(lambda a: bme680_pressure(a, tf), P * 100, 0, 0xFFFFF, falling=True)
            lo = max(0, math.floor(_bme680_humidity_zero(tf)))
            h = invert_monotonic(lambda a: bme680_humidity(a, tf), _clamp(H, 0, 100), lo, 0xFFFF)
            self._memo = (key, (t, p, h))
        return self._memo[1]

    def _gas_word(self) -> tuple:
        """The gas ADC word and range whose resistance is closest to the panel's (kohm)."""
        G = _clamp(self.value('gas', 50), 0.001, 1e6) * 1000
        if self._memo_gas[0] != G:
            best = (512, 0, math.inf)
            for rng in range(16):
                adc = invert_monotonic(lambda a: bme680_gas_low(a, rng), G, 0, 1023, falling=True)
                err = abs(bme680_gas_low(adc, rng) - G)
                if err < best[2]:
                    best = (adc, rng, err)
            self._memo_gas = (G, best[:2])
        return self._memo_gas[1]

    def _measure(self, ctrl_meas: int) -> None:
        r = self.regs
        osrs_t = (ctrl_meas >> 5) & 7
        osrs_p = (ctrl_meas >> 2) & 7
        t, p, h = self._adc_words()
        press = _adc20(p) if osrs_p else [0x80, 0, 0]
        temp = _adc20(t) if osrs_t else [0x80, 0, 0]
        hum = [(h >> 8) & 0xFF, h & 0xFF] if self._osrs_h else [0x80, 0]
        run_gas = (r[_CTRL_GAS_1] & 0x10) != 0
        heater_on = (r[_CTRL_GAS_0] & 0x08) == 0
        gas = [0, 0]
        if run_gas:
            adc, rng = self._gas_word()
            flags = 0x20 | (0x10 if heater_on else 0)
            gas = [(adc >> 2) & 0xFF, ((adc & 0x03) << 6) | flags | rng]
        self._meas_index = (self._meas_index + 1) & 0xFF
        field = [0x80, self._meas_index] + press + temp + hum + [0, 0, 0] + gas + gas
        r[_FIELD0:_FIELD0 + len(field)] = bytes(field)

    def write_register(self, reg: int, value: int) -> None:
        if reg == _RESET:
            if value == 0xB6:
                self._power_on()
            return
        if reg < 0x50 or reg > 0x75:
            return
        if reg != _CTRL_MEAS:
            self.regs[reg] = value
            return
        self._osrs_h = self.regs[_CTRL_HUM] & 0x07
        if (value & 0x03) == 0x01:
            self._measure(value)
            self.regs[reg] = value & ~0x03 & 0xFF
            return
        self.regs[reg] = value


MODELS = {'bmp180': Bmp180, 'bme680': Bme680}

# Imported before catalog_i2c_models (a test, a tool), this module was still
# half-loaded when that one merged its families, so it adds itself as well.
_models.MODELS.update(MODELS)
