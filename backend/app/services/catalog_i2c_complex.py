"""Parts-catalog I2C chips that keep time, for the QEMU worker (ESP32).

Python twins of frontend/src/partsCatalog/models/i2cComplex.ts: chips whose
libraries do more than read a register. They poll for a measurement to finish
(VL53L0X) or drain a sample FIFO the chip fills at its own rate (MAX30102).
Both keep time on the guest's clock (`now_ns`, the worker's QEMU virtual
clock), so a sketch that waits 100 ms finds 100 ms of chip activity. With no
clock (`now_ns` None, the tab's clockHz() 0) a measurement is ready at the
first poll and the FIFO gains one sample per poll, as in the tab.

catalog_i2c_models.py merges MODELS from here (_load_family).
"""

from __future__ import annotations

import math

try:
    from app.services.catalog_i2c_models import _Device, _clamp
    from app.services.catalog_i2c_models import _round as _js_round
except ImportError:
    # The worker loaded catalog_i2c_models by path (no `app` package); it is
    # the module that loads this one, so it is already in sys.modules.
    import importlib.util as _ilu
    import pathlib as _pl
    import sys as _sys

    _base = _sys.modules.get('catalog_i2c_models')
    if _base is None:
        _spec = _ilu.spec_from_file_location(
            'catalog_i2c_models', _pl.Path(__file__).parent / 'catalog_i2c_models.py')
        _base = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
        _sys.modules['catalog_i2c_models'] = _base
        _spec.loader.exec_module(_base)  # type: ignore[union-attr]
    _Device = _base._Device
    _clamp = _base._clamp
    _js_round = _base._round


def _i32(x: int) -> int:
    return ((x + 0x80000000) % 0x100000000) - 0x80000000


class _PointerDevice(_Device):
    """A register-pointer chip: the first byte of a write phase is the
    register, every byte after it goes to the next register, and a read
    continues from the pointer (except where holds_pointer() holds it, a FIFO
    port). PointerDevice in i2cComplex.ts."""

    uses_clock = True

    def __init__(self, address: int, now_ns=None):
        super().__init__(address)
        self._now_ns = now_ns
        self.pointer = 0
        self._expect_pointer = True

    def read_reg(self, reg: int) -> int:
        raise NotImplementedError

    def write_reg(self, reg: int, value: int) -> None:
        raise NotImplementedError

    def holds_pointer(self, reg: int) -> bool:
        return False

    def start(self, read: bool) -> None:
        if not read:
            self._expect_pointer = True

    def stop(self) -> None:
        self._expect_pointer = True

    def write_byte(self, value: int) -> bool:
        if self._expect_pointer:
            self.pointer = value & 0xFF
            self._expect_pointer = False
        else:
            self.write_reg(self.pointer, value & 0xFF)
            self.pointer = (self.pointer + 1) & 0xFF
        return True

    def read_byte(self) -> int:
        self._expect_pointer = True
        reg = self.pointer
        v = self.read_reg(reg) & 0xFF
        if not self.holds_pointer(reg):
            self.pointer = (self.pointer + 1) & 0xFF
        return v

    def now(self):
        """The guest's time in ns, or None when the worker keeps none."""
        return None if self._now_ns is None else self._now_ns()


# ── VL53L0X ──────────────────────────────────────────────────────────────────

_VL_SYSRANGE_START = 0x00
_VL_SEQUENCE_CONFIG = 0x01
_VL_INTERMEASUREMENT = 0x04
_VL_INTERRUPT_CLEAR = 0x0B
_VL_INTERRUPT_STATUS = 0x13
_VL_RANGE_STATUS = 0x14
_VL_PAGE = 0xFF
VL53L0X_OUT_OF_RANGE = 8190
VL53L0X_MAX_MM = 2000


class Vl53l0x(_PointerDevice):
    """VL53L0X as Pololu's VL53L0X library drives it (Vl53l0xModel): model ID
    0xC0 reads 0xEE, tuning registers read back, 0xFF selects a register page
    (stop variable on page 1, NVM SPAD read on pages 6 / 7). A SYSRANGE_START
    write starts a single, back-to-back or timed measurement that completes
    one timing budget later on the guest clock (a reference calibration 1 ms
    later) and raises RESULT_INTERRUPT_STATUS until SYSTEM_INTERRUPT_CLEAR.
    The range (0x1E, big-endian) is the panel's `distance` clamped to 30 mm,
    and 8190 with a phase-fail status above 2000 mm."""

    def __init__(self, address: int, now_ns=None):
        super().__init__(address, now_ns)
        self._pages: dict = {}
        self._page = 0
        # SYSRANGE_START mode in progress: 0 none, 1 single, 2 back-to-back, 4 timed.
        self._mode = 0
        self._start_ns = 0
        self._period_ns = 0
        # Completions counted when the interrupt was last cleared.
        self._cleared = 0
        # No clock: the measurements that completed (one per status poll).
        self._polled = 0
        self._power_on()

    def _regs(self, page: int) -> bytearray:
        r = self._pages.get(page)
        if r is None:
            r = self._pages[page] = bytearray(256)
        return r

    def _power_on(self) -> None:
        self._pages.clear()
        p0 = self._regs(0)
        p0[0xC0] = 0xEE  # IDENTIFICATION_MODEL_ID
        p0[0xC1] = 0xAA
        p0[0xC2] = 0x10  # revision
        p0[0x50] = 0x06  # pre-range VCSEL period 14 PCLKs
        p0[0x70] = 0x04  # final-range VCSEL period 10 PCLKs
        p0[0x46] = 0x25
        p0[0x51] = 0x00
        p0[0x52] = 0x96
        p0[0x71] = 0x01
        p0[0x72] = 0xFE
        p0[0x84] = 0x11  # GPIO_HV_MUX_ACTIVE_HIGH
        p0[0x89] = 0x00
        p0[0xF8] = 0x00  # OSC_CALIBRATE_VAL: the library then takes the period as ms
        p0[0xF9] = 0x00
        p0[0xB0:0xB6] = b'\xff' * 6  # reference SPAD map: every SPAD present
        self._regs(1)[0x91] = 0x3C  # stop variable
        self._regs(7)[0x92] = 0x88  # SPAD info: aperture, 8 SPADs

    def write_reg(self, reg: int, value: int) -> None:
        if reg == _VL_PAGE:
            self._page = value
            return
        self._regs(self._page)[reg] = value
        if self._page != 0:
            return
        if reg == _VL_SYSRANGE_START:
            self._start_ranging(value)
        elif reg == _VL_INTERRUPT_CLEAR and value & 0x01:
            self._cleared = self._completions()

    def read_reg(self, reg: int) -> int:
        if reg == _VL_PAGE:
            return self._page
        r = self._regs(self._page)
        if self._page == 7 and reg == 0x83:
            return 0x10 if r[0x83] == 0 else r[0x83]
        if self._page != 0:
            return r[reg]
        if reg == _VL_SYSRANGE_START:
            return r[reg] & ~0x01
        if reg == _VL_INTERRUPT_STATUS:
            return 0x04 if self._ready() else 0x00
        if reg == _VL_RANGE_STATUS:
            return 0x20 if self._out_of_range() else 0x58
        if reg == _VL_RANGE_STATUS + 10:
            return self._range_mm() >> 8
        if reg == _VL_RANGE_STATUS + 11:
            return self._range_mm() & 0xFF
        return r[reg]

    def _out_of_range(self) -> bool:
        return self.value('distance', 0) > VL53L0X_MAX_MM

    def _range_mm(self) -> int:
        if self._out_of_range():
            return VL53L0X_OUT_OF_RANGE
        return _js_round(_clamp(self.value('distance', 0), 30, VL53L0X_MAX_MM))

    def _start_ranging(self, value: int) -> None:
        r = self._regs(0)
        now = self.now()
        if now is None:
            now = 0
        if value & 0x01:
            # A reference calibration runs the VHV or phase step only: short.
            calibration = (r[_VL_SEQUENCE_CONFIG] & 0x80) == 0
            self._mode = 1
            self._period_ns = 1e6 if calibration else self.budget_us() * 1e3
        elif value & 0x02:
            self._mode = 2
            self._period_ns = self.budget_us() * 1e3
        elif value & 0x04:
            at = _VL_INTERMEASUREMENT
            raw = (r[at] << 24) | (r[at + 1] << 16) | (r[at + 2] << 8) | r[at + 3]
            osc = (r[0xF8] << 8) | r[0xF9]
            period_ms = raw / (osc or 1)
            self._mode = 4
            self._period_ns = max(self.budget_us() * 1e3, period_ms * 1e6)
        else:
            self._mode = 0  # stop
        self._start_ns = now
        self._cleared = 0
        self._polled = 0

    def _completions(self) -> int:
        """Measurements completed since the last SYSRANGE_START."""
        if self._mode == 0:
            return self._cleared
        now = self.now()
        if now is None:
            return self._polled
        n = math.floor((now - self._start_ns) / max(1, self._period_ns))
        return min(1, n) if self._mode == 1 else n

    def _ready(self) -> bool:
        if self._mode != 0 and self.now() is None and self._polled == self._cleared:
            # No clock: the measurement the poll waits for is done.
            if self._mode != 1 or self._polled == 0:
                self._polled += 1
        return self._completions() > self._cleared

    def budget_us(self) -> int:
        """The timing budget in us, from the registers
        getMeasurementTimingBudget() reads."""
        r = self._regs(0)
        seq = r[_VL_SEQUENCE_CONFIG]

        def macro_ns(pclks: int) -> int:
            return (2304 * pclks * 1655 + 500) // 1000

        def mclks_to_us(mclks: int, pclks: int) -> int:
            return math.floor((mclks * macro_ns(pclks) + 500) / 1000)

        def decode(v: int) -> int:
            # JS: an int32 shift whose count is taken mod 32.
            return _i32((v & 0xFF) << (((v >> 8) & 0xFF) & 31)) + 1

        pre_vcsel = (r[0x50] + 1) << 1
        final_vcsel = (r[0x70] + 1) << 1
        msrc_us = mclks_to_us(r[0x46] + 1, pre_vcsel)
        pre_mclks = decode((r[0x51] << 8) | r[0x52]) & 0xFFFF
        pre_us = mclks_to_us(pre_mclks, pre_vcsel)
        final_mclks = decode((r[0x71] << 8) | r[0x72]) & 0xFFFF
        if seq & 0x40:
            final_mclks -= pre_mclks
        final_us = mclks_to_us(final_mclks & 0xFFFF, final_vcsel)
        budget = 1910 + 960
        if seq & 0x10:
            budget += msrc_us + 590
        if seq & 0x08:
            budget += 2 * (msrc_us + 690)
        elif seq & 0x04:
            budget += msrc_us + 660
        if seq & 0x40:
            budget += pre_us + 660
        if seq & 0x80:
            budget += final_us + 550
        return budget


# ── MAX30102 ─────────────────────────────────────────────────────────────────

_MX_INTSTAT1 = 0x00
_MX_INTSTAT2 = 0x01
_MX_FIFO_WR = 0x04
_MX_FIFO_OVF = 0x05
_MX_FIFO_RD = 0x06
_MX_FIFO_DATA = 0x07
_MX_FIFO_CONFIG = 0x08
_MX_MODE = 0x09
_MX_SPO2 = 0x0A
_MX_LED1 = 0x0C
_MX_LED2 = 0x0D
_MX_SLOTS1 = 0x11
_MX_SLOTS2 = 0x12
_MX_TEMP_INT = 0x1F
_MX_TEMP_FRAC = 0x20
_MX_TEMP_CONFIG = 0x21
_FIFO_DEPTH = 32
_SAMPLE_RATES = (50, 100, 200, 400, 800, 1000, 1600, 3200)

# Counts at LED amplitude 0x1F, ADC range 4096 nA: a finger on the sensor, and the bare window.
_IR_FINGER = 100_000
_RED_FINGER = 88_000
_IR_AMBIENT = 1_200
_RED_AMBIENT = 900
# Peak-to-peak of the pulse, in counts of the IR channel (the red one scales with its DC).
_PULSE_PP = 300
_DIE_TEMP_C = 30


def ppg_shape(phase: float) -> float:
    """One period of a fingertip PPG, phase in [0, 1): zero mean, peak-to-peak
    about 1 (ppgShape)."""
    w = 2 * math.pi * phase
    return 0.5 * math.sin(w) + 0.18 * math.sin(2 * w + 0.6) + 0.06 * math.sin(3 * w + 1.2)


class Max30102(_PointerDevice):
    """MAX30102 as SparkFun's MAX3010x library drives it (Max30102Model):
    part ID 0x15, a soft reset done at once, registers read back. The chip
    fills its 32-sample FIFO at the SpO2 sample rate over the FIFO averaging,
    timed on the guest clock, while MODE_CONFIG names a mode and shutdown is
    clear; FIFO_DATA hands out 3 bytes per active channel without moving the
    pointer. With `finger` 1 the IR channel sits at 100000 counts with a PPG
    pulse at `bpm`, the red one at 88000; with `finger` 0 both read ambient.
    Die temperature is 30 C, ready at once."""

    def __init__(self, address: int, now_ns=None):
        super().__init__(address, now_ns)
        self.regs = bytearray(256)
        # The FIFO: one entry per sample, the values of its active channels.
        self._fifo: list = []
        self._wr = 0
        self._rd = 0
        self._overflow = 0
        # Guest ns of the next sample, or None when not sampling.
        self._next_ns = None
        # No clock: the time of the samples made per poll.
        self._fake_ns = 0
        # Heartbeat phase at `_phase_ns`, so a bpm change does not jump the wave.
        self._phase = 0.0
        self._phase_ns = 0
        # The sample being read out of FIFO_DATA.
        self._out_bytes: list = []
        self._new_sample = False
        self._reset()

    def _reset(self) -> None:
        self.regs[:] = bytes(256)
        self.regs[0xFE] = 0x03
        self.regs[0xFF] = 0x15
        self._fifo = []
        self._wr = self._rd = self._overflow = 0
        self._out_bytes = []
        self._next_ns = None
        self.regs[_MX_INTSTAT1] = 0x01  # PWR_RDY

    def holds_pointer(self, reg: int) -> bool:
        return reg == _MX_FIFO_DATA

    def start(self, read: bool) -> None:
        super().start(read)
        if not read:
            self._out_bytes = []

    def _channels(self) -> list:
        """Channels per sample the mode and slots select."""
        mode = self.regs[_MX_MODE] & 0x07
        if mode == 0x02:
            return [1]
        if mode == 0x03:
            return [1, 2]
        if mode == 0x07:
            s1, s2 = self.regs[_MX_SLOTS1], self.regs[_MX_SLOTS2]
            slots = [s1 & 0x07, (s1 >> 4) & 0x07, s2 & 0x07, (s2 >> 4) & 0x07]
            return slots[:slots.index(0)] if 0 in slots else slots
        return []

    def _sampling(self) -> bool:
        return (self.regs[_MX_MODE] & 0x80) == 0 and len(self._channels()) > 0

    def _sample_period_ns(self) -> float:
        rate = _SAMPLE_RATES[(self.regs[_MX_SPO2] >> 2) & 0x07]
        avg = 1 << min(5, (self.regs[_MX_FIFO_CONFIG] >> 5) & 0x07)
        return (1e9 * avg) / rate

    def _sync(self) -> None:
        """Bring the FIFO up to now: every sample the chip took since the last look."""
        if not self._sampling():
            self._next_ns = None
            return
        now = self.now()
        if now is None:
            return
        period = self._sample_period_ns()
        if self._next_ns is None:
            self._next_ns = now + period
            return
        if now < self._next_ns:
            return
        due = math.floor((now - self._next_ns) / period) + 1
        # More than a FIFO's worth only turns the oldest over.
        if due > _FIFO_DEPTH * 2:
            skip = due - _FIFO_DEPTH * 2
            self._next_ns += skip * period
            self._count_dropped(skip)
            due -= skip
        for _ in range(due):
            self._push(self._next_ns)
            self._next_ns += period

    def _count_dropped(self, n: int) -> None:
        self._overflow = min(0x1F, self._overflow + n)

    def _push(self, at_ns: float) -> None:
        sample = [self._channel_value(ch, at_ns) for ch in self._channels()]
        self._new_sample = True
        if len(self._fifo) >= _FIFO_DEPTH:
            self._count_dropped(1)
            if (self.regs[_MX_FIFO_CONFIG] & 0x10) == 0:
                return  # rollover off: dropped
            self._fifo.pop(0)
            self._rd = (self._rd + 1) % _FIFO_DEPTH
        self._fifo.append(sample)
        self._wr = (self._wr + 1) % _FIFO_DEPTH

    def _beat_phase(self, at_ns: float) -> float:
        bpm = _clamp(self.value('bpm', 72), 20, 250)
        # JS % keeps the dividend's sign: math.fmod, not Python's %.
        self._phase = math.fmod(self._phase + ((at_ns - self._phase_ns) / 1e9) * (bpm / 60), 1)
        if self._phase < 0:
            self._phase += 1
        self._phase_ns = at_ns
        return self._phase

    def _channel_value(self, ch: int, at_ns: float) -> int:
        """Counts of one channel (1 red, 2 IR, 3 green) at a guest instant, 18-bit, left-justified."""
        finger = self.value('finger', 0) >= 0.5
        phase = self._beat_phase(at_ns)
        amp = self.regs[_MX_LED1] if ch == 1 else self.regs[_MX_LED2] if ch == 2 else 0
        gain = amp / 0x1F
        rng = 2048 << ((self.regs[_MX_SPO2] >> 5) & 0x03)
        scale = 4096 / rng
        if ch in (1, 2):
            ambient = _IR_AMBIENT if ch == 2 else _RED_AMBIENT
            dc = _IR_FINGER if ch == 2 else _RED_FINGER
            counts = (gain * (dc + _PULSE_PP * (dc / _IR_FINGER) * ppg_shape(phase))
                      if finger else gain * ambient)
        else:
            counts = 400 if finger else 200
        bits = 15 + (self.regs[_MX_SPO2] & 0x03)
        lsb = 1 << (18 - bits)
        v = _js_round(_clamp(counts * scale, 0, 0x3FFFF))
        return v - (v % lsb)

    def write_reg(self, reg: int, value: int) -> None:
        if reg in (_MX_FIFO_WR, _MX_FIFO_RD, _MX_FIFO_OVF):
            self._sync()
            # The library clears all three together: the FIFO starts empty.
            if reg == _MX_FIFO_WR:
                self._wr = value & 0x1F
            elif reg == _MX_FIFO_RD:
                self._rd = value & 0x1F
            else:
                self._overflow = value & 0x1F
            self._fifo = self._fifo[:(self._wr - self._rd + _FIFO_DEPTH) % _FIFO_DEPTH]
            self._out_bytes = []
            return
        if reg == _MX_MODE:
            if value & 0x40:
                self._reset()
                return
            # The samples due so far were taken in the old mode; the new one starts now.
            self._sync()
            self.regs[reg] = value
            self._sync()
            return
        if reg == _MX_TEMP_CONFIG:
            if value & 0x01:
                t = _DIE_TEMP_C
                self.regs[_MX_TEMP_INT] = math.floor(t) & 0xFF
                self.regs[_MX_TEMP_FRAC] = _js_round((t - math.floor(t)) / 0.0625) & 0x0F
                self.regs[_MX_INTSTAT2] |= 0x02
            return
        if reg in (_MX_INTSTAT1, _MX_INTSTAT2, _MX_FIFO_DATA, 0xFE, 0xFF):
            return  # read-only
        self._sync()
        self.regs[reg] = value
        self._sync()

    def read_reg(self, reg: int) -> int:
        if reg == _MX_INTSTAT1:
            self._sync()
            v = self.regs[_MX_INTSTAT1] & 0x01
            if self._new_sample:
                v |= 0x40  # PPG_RDY
            free = _FIFO_DEPTH - len(self._fifo)
            if free <= (self.regs[_MX_FIFO_CONFIG] & 0x0F):
                v |= 0x80  # A_FULL
            self.regs[_MX_INTSTAT1] = 0
            self._new_sample = False
            return v
        if reg == _MX_INTSTAT2:
            v = self.regs[_MX_INTSTAT2]
            self.regs[_MX_INTSTAT2] = 0
            return v
        if reg == _MX_FIFO_WR:
            self._sync()
            if self.now() is None and self._sampling() and not self._fifo:
                # No clock: a sample per poll, a sample period apart.
                self._fake_ns += self._sample_period_ns()
                self._push(self._fake_ns)
            return self._wr
        if reg == _MX_FIFO_RD:
            self._sync()
            return self._rd
        if reg == _MX_FIFO_OVF:
            self._sync()
            return self._overflow
        if reg == _MX_FIFO_DATA:
            return self._fifo_byte()
        if reg == _MX_TEMP_FRAC:
            self.regs[_MX_INTSTAT2] &= ~0x02 & 0xFF
            return self.regs[reg]
        return self.regs[reg]

    def _fifo_byte(self) -> int:
        if not self._out_bytes:
            if not self._fifo:
                return 0
            sample = self._fifo.pop(0)
            self._rd = (self._rd + 1) % _FIFO_DEPTH
            self._overflow = 0
            for v in sample:
                self._out_bytes += [(v >> 16) & 0x03, (v >> 8) & 0xFF, v & 0xFF]
        return self._out_bytes.pop(0) if self._out_bytes else 0


MODELS = {'vl53l0x': Vl53l0x, 'max30102': Max30102}
