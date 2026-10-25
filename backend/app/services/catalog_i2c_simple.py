"""Register-file catalog chips for the QEMU worker (ESP32): ADXL345, INA219,
MLX90614, QMC5883L and CCS811.

Python twins of frontend/src/partsCatalog/models/i2cSimple.ts, line for line:
each answers what its card's library reads and checks (Adafruit ADXL345 1.3,
Adafruit INA219 1.2, Adafruit MLX90614 2.1, QMC5883LCompass 1.2, Adafruit
CCS811 1.1), from the sensor panel's values. catalog_i2c_models.py loads this
module and merges its MODELS.

Only the CCS811 keeps time (its drive mode sets when a sample is ready), on
the guest's clock; the others have a measurement ready at once.

One host difference the twins absorb: QEMU ends a write phase before a
repeated START (a FINISH, then the START), where the tab's fabric goes
straight from the write phase to the read phase. Every model here but the
CCS811 keeps its pointer or command over a FINISH anyway; the CCS811 commits a
mailbox write at the STOP, so it holds a bare mailbox selection until it hears
which START follows.
"""

from __future__ import annotations

import math

try:  # imported as app.services.catalog_i2c_simple
    from app.services import catalog_i2c_models as _models
except ImportError:  # loaded by path beside catalog_i2c_models (the worker's fallback)
    import catalog_i2c_models as _models  # type: ignore[no-redef]

_clamp, _Device, _round, _tdiv = _models._clamp, _models._Device, _models._round, _models._tdiv


class _PointerDevice(_Device):
    """The usual 8-bit register file: the first byte of a write is the
    register pointer, the bytes after it are written there, and both
    directions move the pointer on by one (PointerDevice in i2cSimple.ts)."""

    def __init__(self, address: int):
        super().__init__(address)
        self.pointer = 0
        self._awaiting_pointer = True
        self._reading = False

    def read_register(self, reg: int) -> int:
        raise NotImplementedError

    def write_register(self, reg: int, value: int) -> None:
        raise NotImplementedError

    def next(self, reg: int) -> int:
        """The register after `reg` in a burst."""
        return (reg + 1) & 0xFF

    def begin_read(self) -> None:
        """A read phase begins: a chip that latches a sample for the burst does it here."""

    def write_byte(self, value: int) -> bool:
        self._reading = False
        if self._awaiting_pointer:
            self.pointer = value & 0xFF
            self._awaiting_pointer = False
        else:
            self.write_register(self.pointer, value & 0xFF)
            self.pointer = self.next(self.pointer)
        return True

    def read_byte(self) -> int:
        # A host that does not report STARTs: the read began at its first byte.
        if not self._reading:
            self.start(True)
        v = self.read_register(self.pointer) & 0xFF
        self.pointer = self.next(self.pointer)
        return v

    def start(self, read: bool) -> None:
        self._reading = read
        if read:
            self.begin_read()
        else:
            self._awaiting_pointer = True

    def stop(self) -> None:
        self._awaiting_pointer = True
        self._reading = False


# ── ADXL345 ─────────────────────────────────────────────────────────────────


class Adxl345(_PointerDevice):
    """ADXL345 accelerometer (Adxl345Model): DEVID 0xE5, DATAX0..DATAZ1
    little-endian at 4 mg per LSB at full resolution (250 per g), halving per
    range step in 10-bit mode; JUSTIFY left-aligns, OFSX/Y/Z add 15.6 mg per
    LSB. In standby the data registers keep the last sample."""

    def __init__(self, address: int):
        super().__init__(address)
        self.regs = bytearray(64)
        self._sample = [0, 0, 0, 0, 0, 0]
        self._reset()

    def _reset(self) -> None:
        self.regs[:] = bytes(64)
        self.regs[0x00] = 0xE5  # DEVID
        self.regs[0x2C] = 0x0A  # BW_RATE: 100 Hz
        self.regs[0x30] = 0x02  # INT_SOURCE: watermark

    @property
    def _measuring(self) -> bool:
        return (self.regs[0x2D] & 0x08) != 0

    def _count(self, g: float, offset_reg: int) -> int:
        """The count of one axis for `g`, as DATA_FORMAT sets it."""
        fmt = self.regs[0x31]
        rng = fmt & 0x03
        full_res = (fmt & 0x08) != 0
        bits = 10 + rng if full_res else 10
        off = self.regs[offset_reg]
        offset_g = (off - 256 if off & 0x80 else off) * 0.0156
        lsb_per_g = 250 if full_res else 250 / (1 << rng)
        raw = int(_clamp(_round((g + offset_g) * lsb_per_g), -(1 << (bits - 1)), (1 << (bits - 1)) - 1))
        # JUSTIFY: MSB-aligned in the 16 bits.
        return (raw << (16 - bits) if fmt & 0x04 else raw) & 0xFFFF

    def _latch(self) -> None:
        if not self._measuring:
            return
        axes = [self._count(self.value('accelX', 0), 0x1E),
                self._count(self.value('accelY', 0), 0x1F),
                self._count(self.value('accelZ', 1), 0x20)]
        self._sample = [b for c in axes for b in (c & 0xFF, c >> 8)]

    def begin_read(self) -> None:
        if 0x32 <= self.pointer <= 0x37:
            self._latch()

    def next(self, reg: int) -> int:
        return (reg + 1) & 0x3F

    def read_register(self, reg: int) -> int:
        if 0x32 <= reg <= 0x37:
            return self._sample[reg - 0x32]
        # A new sample is always there while measuring: DATA_READY.
        if reg == 0x30:
            return self.regs[0x30] | (0x80 if self._measuring else 0)
        return self.regs[reg]

    def write_register(self, reg: int, value: int) -> None:
        # DEVID, the tap/activity source, INT_SOURCE, the data and FIFO_STATUS are read-only.
        if reg == 0x00 or 0x01 <= reg <= 0x1C or reg in (0x2B, 0x30, 0x39) or 0x32 <= reg <= 0x37:
            return
        self.regs[reg] = value


# ── INA219 ──────────────────────────────────────────────────────────────────

# The shunt of the usual INA219 breakout (Adafruit, CJMCU, GY-219).
_INA219_SHUNT_OHMS = 0.1


class Ina219(_Device):
    """INA219 current monitor with the module's 0.1 ohm shunt (Ina219Model):
    16-bit registers MSB first; shunt in 10 uV clipped at the PGA range, bus in
    4 mV at bit 3 with CNVR, current = shunt x CALIBRATION / 4096 and power =
    current x bus / 5000 as the chip computes them. Power-down and ADC-off
    modes hold the last conversion; RST in CONFIG resets."""

    def __init__(self, address: int):
        super().__init__(address)
        self.config = 0x399F
        self.calibration = 0
        self.pointer = 0
        self._written: list = []
        self._awaiting_pointer = True
        self._half = 0
        self._held = (0, 0)

    def _conversion(self) -> tuple:
        """Shunt and bus registers of the conversion the chip has now."""
        mode = self.config & 0x07
        if mode in (0, 4):
            return self._held
        pga_mv = 40 << ((self.config >> 11) & 0x03)
        shunt_mv = self.value('current', 0) * _INA219_SHUNT_OHMS
        shunt = int(_clamp(_round(shunt_mv * 100), -pga_mv * 100, pga_mv * 100))
        fsr = 32 if self.config & 0x2000 else 16
        bus = int(_clamp(_round(_clamp(self.value('busVoltage', 0), 0, fsr) / 0.004), 0, 0x1FFF))
        # Triggered modes (1-3) convert once per CONFIG write; the panel moves
        # the world, so the next trigger reads it: convert now, as the tab does.
        self._held = (shunt if mode & 0x01 else self._held[0], bus if mode & 0x02 else self._held[1])
        return self._held

    def _register(self, reg: int) -> int:
        shunt, bus = self._conversion()
        current = _tdiv(shunt * self.calibration, 4096)
        power = (abs(current) * bus) // 5000
        overflow = current > 0x7FFF or current < -0x8000 or power > 0xFFFF
        if reg == 0x00:
            return self.config
        if reg == 0x01:
            return shunt & 0xFFFF
        if reg == 0x02:
            return (bus << 3) | (0x02 if self.calibration else 0) | (0x01 if overflow else 0)
        if reg == 0x03:
            return 0 if overflow else power
        if reg == 0x04:
            return 0 if overflow else current & 0xFFFF
        if reg == 0x05:
            return self.calibration
        return 0

    def write_byte(self, value: int) -> bool:
        if self._awaiting_pointer:
            self.pointer = value & 0x07
            self._awaiting_pointer = False
            self._written = []
            self._half = 0
            return True
        self._written.append(value & 0xFF)
        if len(self._written) == 2:
            word = (self._written[0] << 8) | self._written[1]
            self._written = []
            if self.pointer == 0x00:
                if word & 0x8000:
                    self.config = 0x399F
                    self.calibration = 0
                else:
                    self.config = word
            elif self.pointer == 0x05:
                self.calibration = word & 0xFFFE
        return True

    def read_byte(self) -> int:
        word = self._register(self.pointer)
        v = word >> 8 if self._half == 0 else word & 0xFF
        self._half ^= 1
        return v & 0xFF

    def start(self, read: bool) -> None:
        self._half = 0
        if not read:
            self._awaiting_pointer = True

    def stop(self) -> None:
        self._awaiting_pointer = True
        self._half = 0


# ── MLX90614 ────────────────────────────────────────────────────────────────


def smbus_pec(data) -> int:
    """SMBus PEC: CRC-8, polynomial 0x07, init 0, over every byte on the wire."""
    crc = 0
    for b in data:
        crc ^= b & 0xFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


_MLX_EEPROM_DEFAULTS = {
    0x00: 0x9993,  # To max
    0x01: 0x62E3,  # To min
    0x02: 0x0201,  # PWM control
    0x03: 0xF71C,  # Ta range
    0x04: 0xFFFF,  # emissivity 1.0
    0x05: 0x9FB4,  # config register 1
    0x0E: 0xBE5A,  # SMBus address 0x5A
    0x1C: 0x1234,  # ID number
    0x1D: 0x5678,
    0x1E: 0x9ABC,
    0x1F: 0xDEF0,
}


class Mlx90614(_Device):
    """MLX90614 IR thermometer, SMBus "read word" (Mlx90614Model): a command
    (0x00-0x1F RAM, 0x20-0x3F EEPROM), a repeated START, then LSB, MSB and the
    PEC over address, command, address+R and the two data bytes. TA (0x06)
    and TOBJ1 (0x07, also TOBJ2) are kelvin in 0.02 K. A word written to
    EEPROM is taken only with a correct PEC."""

    def __init__(self, address: int):
        super().__init__(address)
        self.eeprom = [0] * 32
        for k, v in _MLX_EEPROM_DEFAULTS.items():
            self.eeprom[k] = v
        self.eeprom[0x0E] = (self.eeprom[0x0E] & 0xFF00) | (address & 0x7F)
        self.command: list = []
        self._frame: list = []
        self._index = 0
        self._closed = True
        self._reading = False

    @staticmethod
    def _kelvin(celsius: float) -> int:
        return int(_clamp(_round((celsius + 273.15) / 0.02), 0, 0x7FFF))

    def _word(self, cmd: int) -> int:
        if 0x20 <= cmd <= 0x3F:
            return self.eeprom[cmd - 0x20]
        ambient = self.value('ambientTemp', 25)
        obj = self.value('objectTemp', 25)
        if cmd in (0x04, 0x05):  # raw IR channel: grows with the object-to-ambient difference
            return _round(_clamp((obj - ambient) * 40, -0x7FFF, 0x7FFF)) & 0xFFFF
        if cmd == 0x06:
            return self._kelvin(ambient)
        if cmd in (0x07, 0x08):
            return self._kelvin(obj)
        return 0

    def write_byte(self, value: int) -> bool:
        self._reading = False
        if self._closed:
            self.command = []
        self._closed = False
        self.command.append(value & 0xFF)
        return True

    def start(self, read: bool) -> None:
        self._closed = True
        self._reading = read
        if not read:
            return
        cmd = self.command[0] if self.command else 0
        w = self._word(cmd)
        lo, hi = w & 0xFF, w >> 8
        a = (self.address & 0x7F) << 1
        self._frame = [lo, hi, smbus_pec([a, cmd, a | 1, lo, hi])]
        self._index = 0

    def read_byte(self) -> int:
        if not self._reading:
            self.start(True)
        if self._index < len(self._frame):
            b = self._frame[self._index]
            self._index += 1
            return b
        return 0xFF

    def stop(self) -> None:
        # A write word: command, LSB, MSB, PEC over address+W and those three.
        c = self.command
        if not self._closed and len(c) == 4 and 0x20 <= c[0] <= 0x3F:
            a = (self.address & 0x7F) << 1
            if smbus_pec([a, c[0], c[1], c[2]]) == c[3]:
                self.eeprom[c[0] - 0x20] = c[1] | (c[2] << 8)
        self._closed = True
        self._reading = False
        self._index = 0


# ── QMC5883L ────────────────────────────────────────────────────────────────

# Horizontal and vertical earth field the module sees, in gauss.
_EARTH_HORIZONTAL_G = 0.3
_EARTH_VERTICAL_G = -0.4


class Qmc5883l(_PointerDevice):
    """QMC5883L magnetometer, GY-271 (Qmc5883lModel): X, Y, Z little-endian
    from 0x00, the horizontal field turned so QMC5883LCompass's truncated
    atan2 prints the panel's heading (above 180 in its negative form).
    Standby holds the last sample; SOFT_RST in CONTROL2 resets; 0x0D reads
    0xFF."""

    def __init__(self, address: int):
        super().__init__(address)
        self.regs = bytearray(16)
        self._sample = [0, 0, 0, 0, 0, 0]
        self._reset()

    def _reset(self) -> None:
        self.regs[:] = bytes(16)
        self.regs[0x0D] = 0xFF
        self._sample = [0, 0, 0, 0, 0, 0]

    @property
    def _continuous(self) -> bool:
        return (self.regs[0x09] & 0x03) == 0x01

    @staticmethod
    def field_for(heading: float, lsb_per_gauss: int) -> tuple:
        """X, Y, Z counts for a heading in degrees."""
        h = ((_round(heading) % 360) + 360) % 360
        # What the library prints for this field: atan2 is in (-180, 180].
        printed = h if h <= 180 else h - 360
        horizontal = _EARTH_HORIZONTAL_G * lsb_per_gauss
        z = _round(_EARTH_VERTICAL_G * lsb_per_gauss)
        if printed == 180:
            return (-_round(horizontal), 0, z)
        deg = printed + 0.5 if printed >= 0 else printed - 0.5
        rad = (deg * math.pi) / 180
        return (_round(horizontal * math.cos(rad)), _round(horizontal * math.sin(rad)), z)

    def _latch(self) -> None:
        if not self._continuous:
            return
        lsb_per_gauss = 3000 if self.regs[0x09] & 0x10 else 12000
        counts = self.field_for(self.value('heading', 0), lsb_per_gauss)
        self._sample = [b for c in counts for b in (c & 0xFF, (c >> 8) & 0xFF)]

    def begin_read(self) -> None:
        if self.pointer <= 0x05:
            self._latch()

    def next(self, reg: int) -> int:
        # ROL_PNT or not, a burst from 0x00 reads the six data bytes and status.
        return (reg + 1) & 0x0F

    def read_register(self, reg: int) -> int:
        if reg <= 0x05:
            return self._sample[reg]
        if reg == 0x06:
            return 0x01 if self._continuous else 0x00  # DRDY
        if reg == 0x07:
            return 2500 & 0xFF  # temperature: 100 LSB/degC, offset uncalibrated
        if reg == 0x08:
            return 2500 >> 8
        return self.regs[reg]

    def write_register(self, reg: int, value: int) -> None:
        if reg == 0x0A and value & 0x80:
            self._reset()
            return
        if 0x09 <= reg <= 0x0B:
            self.regs[reg] = value


# ── CCS811 ──────────────────────────────────────────────────────────────────

_CCS811_PERIOD_MS = [0, 1000, 10000, 60000, 250]
_CCS811_RESET_SEQUENCE = [0x11, 0xE5, 0x72, 0x8A]


class Ccs811(_Device):
    """CCS811 air-quality sensor (Ccs811Model): soft reset 0xFF + 11 E5 72 8A,
    HW_ID 0x81, APP_START (0xF4, no data), MEAS_MODE drive modes; STATUS
    DATA_READY one drive-mode period (1 s, 10 s, 60 s, 250 ms) after the mode
    was set and every period after, on the guest's clock, cleared by a read of
    ALG_RESULT_DATA. Without a clock (now_ns None) one sample is ready per
    mode set, as the tab's model does with clockHz() 0. A mailbox it does not
    have sets ERROR with an ERROR_ID bit, which a read of ERROR_ID clears.

    QEMU reports a repeated START as FINISH then START, and a write commits
    at the STOP: a write phase of a bare mailbox byte is held at the FINISH
    and committed only if a write START (not a read) follows, so selecting a
    mailbox to read does not count as writing it."""

    uses_clock = True

    def __init__(self, address: int, now_ns=None):
        super().__init__(address)
        self._now_ns = now_ns
        self._app_mode = False
        self._meas_mode = 0
        self._error_id = 0
        self._baseline = [0x84, 0x7B]
        # Guest ns the drive mode was set at; samples taken up to the last
        # ALG_RESULT_DATA read; without a clock, no sample read since the
        # last one was taken.
        self._mode_since = self._now()
        self._samples_read = 0
        self._unread = True

        self._mailbox = 0
        self._awaiting_mailbox = True
        self._written: list = []
        self._frame: list = []
        self._index = 0
        self._reading = False
        # A FINISH after a bare mailbox byte: a STOP or a repeated START.
        self._held_stop = False

    def _now(self) -> int:
        return self._now_ns() if self._now_ns is not None else 0

    @property
    def _drive_mode(self) -> int:
        return (self._meas_mode >> 4) & 0x07

    def _samples_taken(self) -> int:
        mode = self._drive_mode
        period = _CCS811_PERIOD_MS[mode] if mode < len(_CCS811_PERIOD_MS) else 0
        if not self._app_mode or period == 0 or self._now_ns is None:
            return 0
        return math.floor((self._now() - self._mode_since) / (period * 1_000_000))

    @property
    def _data_ready(self) -> bool:
        if not self._app_mode or self._drive_mode == 0:
            return False
        return self._samples_taken() > self._samples_read if self._now_ns is not None else self._unread

    def _status(self) -> int:
        return ((0x80 if self._app_mode else 0) | 0x10 | (0x08 if self._data_ready else 0)
                | (0x01 if self._error_id else 0))

    def _reset(self) -> None:
        self._app_mode = False
        self._meas_mode = 0
        self._error_id = 0
        self._samples_read = 0
        self._unread = True

    def _set_meas_mode(self, value: int) -> None:
        if ((value >> 4) & 0x07) > 4:
            self._error_id |= 0x04  # MEASMODE_INVALID
            return
        self._meas_mode = value & 0x7C
        self._mode_since = self._now()
        self._samples_read = 0
        self._unread = True

    def _frame_for(self, mailbox: int):
        """The bytes a read of `mailbox` returns, or None when this mode has no such mailbox."""
        if mailbox == 0x00:
            return [self._status()]
        if mailbox == 0x20:
            return [0x81]
        if mailbox == 0x21:
            return [0x12]
        if mailbox == 0x23:
            return [0x10, 0x00]
        if mailbox == 0x24:
            return [0x20, 0x00]
        if mailbox == 0xE0:
            e = self._error_id
            self._error_id = 0
            return [e]
        if not self._app_mode:
            return None
        eco2 = _round(_clamp(self.value('eco2', 400), 400, 8192))
        tvoc = _round(_clamp(self.value('tvoc', 0), 0, 1187))
        # RAW_DATA: 16 uA through the sensor, its voltage falling as VOCs rise.
        adc = _round(_clamp(600 - tvoc * 0.3, 0, 1023))
        raw = [(16 << 2) | (adc >> 8), adc & 0xFF]
        if mailbox == 0x01:
            return [self._meas_mode]
        if mailbox == 0x02:
            out = [eco2 >> 8, eco2 & 0xFF, tvoc >> 8, tvoc & 0xFF, self._status(), self._error_id] + raw
            self._samples_read = self._samples_taken()
            self._unread = False
            return out
        if mailbox == 0x03:
            return raw
        if mailbox == 0x06:
            return [0x04, 0x00, 0x04, 0x00]  # NTC: Vref = Vntc, 25 degC on the reference resistor
        if mailbox == 0x11:
            return list(self._baseline)
        return None

    def _commit_write(self) -> None:
        data = self._written
        m = self._mailbox
        if m == 0xFF:
            if data == _CCS811_RESET_SEQUENCE:
                self._reset()
            return
        if not self._app_mode:
            if m == 0xF4 and not data:
                self._app_mode = True
                self._mode_since = self._now()
                self._samples_read = 0
            elif m < 0xF1 or m > 0xF4:
                self._error_id |= 0x01  # WRITE_REG_INVALID
            return
        if m == 0x01 and len(data) >= 1:
            self._set_meas_mode(data[0])
        elif m == 0x11 and len(data) >= 2:
            self._baseline = data[:2]
        elif m in (0x05, 0x10):
            return  # ENV_DATA, THRESHOLDS: taken, not used
        elif m not in (0x01, 0x11):
            self._error_id |= 0x01

    def _end_write(self) -> None:
        """The tab model's stop()."""
        if not self._awaiting_mailbox:
            self._commit_write()
        self._awaiting_mailbox = True
        self._reading = False
        self._written = []

    def write_byte(self, value: int) -> bool:
        self._reading = False
        if self._awaiting_mailbox:
            self._mailbox = value & 0xFF
            self._awaiting_mailbox = False
            self._written = []
        else:
            self._written.append(value & 0xFF)
        return True

    def start(self, read: bool) -> None:
        if self._held_stop:
            self._held_stop = False
            if not read:
                # The FINISH was a STOP: the bare mailbox write counts.
                self._end_write()
        self._reading = read
        if not read:
            self._awaiting_mailbox = True
            return
        # The write phase before a repeated START only chose the mailbox to read.
        self._awaiting_mailbox = True
        frame = self._frame_for(self._mailbox)
        if frame is None:
            self._error_id |= 0x02  # READ_REG_INVALID
            self._frame = []
        else:
            self._frame = frame
        self._index = 0

    def read_byte(self) -> int:
        if not self._reading:
            self.start(True)
        if self._index < len(self._frame):
            b = self._frame[self._index]
            self._index += 1
            return b
        return 0x00

    def stop(self) -> None:
        if not self._awaiting_mailbox and not self._written:
            self._held_stop = True
            self._reading = False
            return
        if self._held_stop:
            return
        self._end_write()


MODELS = {'adxl345': Adxl345, 'ina219': Ina219, 'mlx90614': Mlx90614, 'qmc5883l': Qmc5883l, 'ccs811': Ccs811}

# Imported before catalog_i2c_models (a test, a tool), this module was still
# half-loaded when that one merged its families, so it adds itself as well.
_models.MODELS.update(MODELS)
