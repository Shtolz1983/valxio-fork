"""Parts-catalog SPI chips for the QEMU worker (ESP32).

The canvas modules of the parts catalogue answer the bus from TypeScript
models in the tab (frontend/src/partsCatalog/models/spi.ts). An ESP32 runs its
firmware here, beside QEMU, and asks for every MISO byte synchronously, so the
tab is too far away: these are Python twins of those models, line for line,
answering the same library traffic.

They travel in the tab's SPI bus map like a portable (WASM) model does, with
`model.catalog` naming the chip ('max6675', 'max31865', 'rc522') instead of
`wasm_b64`, and the panel's values as the model's attributes (`attrs` in the
map, `bus_attrs` between maps). CatalogSpiRuntime gives a twin the parts of
WasmChipRuntime the worker's SPI table uses, so the worker hosts it the way it
hosts a WASM model: a hardware controller's bytes arrive through
spi_transfer_byte, chip-select and clock edges through notify_pin_change.

A twin has the tab's SpiDevice shape: select(), deselect(), transfer(mosi)
and peek_miso(). The runtime also decodes a bit-banged master from the pin
edges (buses/softSpi.ts, line for line), because the MAX6675 library never
uses the SPI peripheral: it toggles SCK on a plain GPIO and reads SO with
digitalRead. The bit goes onto MISO inside the clock edge's pin callback, on
the QEMU thread, so it is there before the guest's next digitalRead.
"""

from __future__ import annotations

import importlib
import importlib.util
import math
import pathlib
import sys


def _num(value, default: float) -> float:
    """`num` of spi.ts: a finite number, else the default."""
    if isinstance(value, bool):
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _js_round(x: float) -> int:
    """JavaScript Math.round: halves go up, toward +infinity."""
    r = math.floor(x)
    return int(r + 1 if x - r >= 0.5 else r)


class _SpiChip:
    """A model as the tab writes it; `values` are the panel's."""

    def __init__(self) -> None:
        self.values: dict = {}

    def value(self, key: str, default: float) -> float:
        return _num(self.values.get(key), default)

    def select(self) -> None:
        pass

    def deselect(self) -> None:
        pass

    def transfer(self, mosi: int) -> int:
        return 0

    def peek_miso(self) -> int:
        return 0


# ── MAX6675 ─────────────────────────────────────────────────────────────────


def max6675_word(celsius: float) -> int:
    """The 16-bit word the MAX6675 shifts out: D14..D3 = °C × 4, D2 = open input (0)."""
    counts = max(0, min(4095, _js_round(celsius * 4)))
    return counts << 3


class Max6675(_SpiChip):
    """MAX6675 (Adafruit "MAX6675 library", bit-banged mode 0): latches the
    panel temperature on select and shifts the word out MSB first."""

    def __init__(self) -> None:
        super().__init__()
        self._word = 0
        self._pos = 0

    def _latch(self) -> None:
        self._word = max6675_word(self.value('temperature', 25))

    def select(self) -> None:
        self._latch()
        self._pos = 0

    def deselect(self) -> None:
        self._pos = 0

    def _byte(self, pos: int) -> int:
        if pos == 0:
            return (self._word >> 8) & 0xFF
        if pos == 1:
            return self._word & 0xFF
        return 0

    def transfer(self, mosi: int) -> int:
        if self._pos == 0:
            self._latch()
        out = self._byte(self._pos)
        self._pos += 1
        return out

    def peek_miso(self) -> int:
        if self._pos == 0:
            self._latch()
        return self._byte(self._pos)


# ── MAX31865 ────────────────────────────────────────────────────────────────

RTD_A = 3.9083e-3
RTD_B = -5.775e-7
# The example's board: a PT100 against a 430 Ω reference.
RTD_NOMINAL = 100
RTD_REF = 430


def max31865_library_celsius(raw15: float, nominal: float = RTD_NOMINAL, ref: float = RTD_REF) -> float:
    """Adafruit_MAX31865::calculateTemperature, line for line."""
    rt = (raw15 / 32768) * ref
    z1 = -RTD_A
    z2 = RTD_A * RTD_A - 4 * RTD_B
    z3 = (4 * RTD_B) / nominal
    z4 = 2 * RTD_B
    temp = (math.sqrt(z2 + z3 * rt) + z1) / z4
    if temp >= 0:
        return temp
    rt = (rt / nominal) * 100
    rpoly = rt
    temp = -242.02
    temp += 2.2228 * rpoly
    rpoly *= rt
    temp += 2.5859e-3 * rpoly
    rpoly *= rt
    temp -= 4.826e-6 * rpoly
    rpoly *= rt
    temp -= 2.8183e-8 * rpoly
    rpoly *= rt
    temp += 1.5243e-10 * rpoly
    return temp


def max31865_raw(celsius: float, nominal: float = RTD_NOMINAL, ref: float = RTD_REF) -> int:
    """The 15-bit RTD ratio whose decode by the library comes closest to
    `celsius` (max31865Raw in spi.ts)."""
    if celsius >= 0:
        ohms = nominal * (1 + RTD_A * celsius + RTD_B * celsius * celsius)
    else:
        lo = 0.0
        hi = nominal * 1.01
        for _ in range(60):
            mid = (lo + hi) / 2
            if max31865_library_celsius((mid / ref) * 32768, nominal, ref) < celsius:
                lo = mid
            else:
                hi = mid
        ohms = (lo + hi) / 2
    exact = max(0.0, min(0x7FFF, (ohms / ref) * 32768))
    a = math.floor(exact)
    b = min(0x7FFF, a + 1)

    def err(r: int) -> float:
        return abs(max31865_library_celsius(r, nominal, ref) - celsius)

    return b if err(b) < err(a) else a


CFG_BIAS = 0x80
CFG_AUTO = 0x40
CFG_1SHOT = 0x20
CFG_FAULT_CYCLE = 0x0C
CFG_FAULT_CLEAR = 0x02


class Max31865(_SpiChip):
    """MAX31865 (Adafruit_MAX31865, SPI mode 1): config 0x00, RTD 0x01/0x02,
    fault thresholds 0x03..0x06, fault status 0x07; reads auto-increment,
    writes are address | 0x80; a 1-shot (or a read in auto mode) converts the
    panel temperature for a PT100 against 430 Ω."""

    def __init__(self) -> None:
        super().__init__()
        self._regs = [0] * 8
        self._pos = 0
        self._addr = 0
        self._write = False
        self._power_on()

    def _power_on(self) -> None:
        self._regs = [0] * 8
        self._regs[3] = 0xFF
        self._regs[4] = 0xFF
        self._pos = 0

    def _convert(self) -> None:
        raw = max31865_raw(max(-200.0, min(850.0, self.value('temperature', 25))))
        high = ((self._regs[3] << 8) | self._regs[4]) >> 1
        low = ((self._regs[5] << 8) | self._regs[6]) >> 1
        fault = 0
        if raw > high:
            fault |= 0x80
        if raw < low:
            fault |= 0x40
        self._regs[7] |= fault
        word = (raw << 1) | (1 if self._regs[7] else 0)
        self._regs[1] = (word >> 8) & 0xFF
        self._regs[2] = word & 0xFF

    def _read(self, addr: int) -> int:
        a = addr & 0x07
        if a in (1, 2) and (self._regs[0] & (CFG_BIAS | CFG_AUTO)) == (CFG_BIAS | CFG_AUTO):
            if a == 1:
                self._convert()
        return self._regs[a]

    def _write_reg(self, addr: int, value: int) -> None:
        a = addr & 0x07
        if a == 0:
            if value & CFG_FAULT_CLEAR:
                self._regs[7] = 0
                self._regs[2] &= 0xFE
            # Fault-cycle and fault-clear bits read back 0 once done (at once here).
            self._regs[0] = value & ~(CFG_FAULT_CYCLE | CFG_FAULT_CLEAR | CFG_1SHOT) & 0xFF
            if value & CFG_1SHOT:
                self._convert()
            elif (value & (CFG_BIAS | CFG_AUTO)) == (CFG_BIAS | CFG_AUTO):
                self._convert()
        elif 3 <= a <= 6:
            self._regs[a] = value & 0xFF
        # 0x01, 0x02 and 0x07 are read-only.

    def select(self) -> None:
        self._pos = 0

    def deselect(self) -> None:
        self._pos = 0

    def transfer(self, mosi: int) -> int:
        first = self._pos == 0
        self._pos += 1
        if first:
            self._write = (mosi & 0x80) != 0
            self._addr = mosi & 0x7F
            return 0
        if self._write:
            self._write_reg(self._addr, mosi)
            self._addr = (self._addr + 1) & 0x7F
            return 0
        out = self._read(self._addr)
        self._addr = (self._addr + 1) & 0x7F
        return out

    def peek_miso(self) -> int:
        if self._pos == 0 or self._write:
            return 0
        return self._regs[self._addr & 0x07]


# ── MFRC522 ─────────────────────────────────────────────────────────────────

# The panel's `tag` choices: 4-byte single-size UIDs.
RC522_TAGS = (
    (0xDE, 0xAD, 0xBE, 0xEF),
    (0x12, 0x34, 0x56, 0x78),
    (0xA1, 0xB2, 0xC3, 0xD4),
    (0x04, 0x7F, 0x3A, 0x91),
)


def crc_a(data, preset: int = 0x6363) -> int:
    """ISO/IEC 14443-3 CRC_A (reflected 0x8408) from `preset`; low byte first on the air."""
    crc = preset & 0xFFFF
    for d in data:
        b = (d ^ crc) & 0xFF
        b = (b ^ (b << 4)) & 0xFF
        crc = ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xFFFF
    return crc


R_COMMAND = 0x01
R_COMIRQ = 0x04
R_DIVIRQ = 0x05
R_ERROR = 0x06
R_FIFODATA = 0x09
R_FIFOLEVEL = 0x0A
R_CONTROL = 0x0C
R_BITFRAMING = 0x0D
R_MODE = 0x11
R_TXCONTROL = 0x14
R_CRCRESULT_H = 0x21
R_CRCRESULT_L = 0x22
R_TMODE = 0x2A
R_VERSION = 0x37

# Power-on values (MFRC522 datasheet, section 9.3); the rest reset to 0.
_RESET = {
    0x01: 0x20, 0x02: 0x80, 0x04: 0x14, 0x07: 0x21, 0x0B: 0x08, 0x0C: 0x10,
    0x0E: 0xA0, 0x11: 0x3F, 0x14: 0x80, 0x16: 0x10, 0x17: 0x84, 0x18: 0x84,
    0x19: 0x4D, 0x1A: 0x00, 0x21: 0xFF, 0x22: 0xFF, 0x24: 0x26, 0x26: 0x48,
    0x27: 0x88, 0x28: 0x20, 0x29: 0x20, 0x37: 0x92,
}

CMD_MEM = 0x1
CMD_CALC_CRC = 0x3
CMD_TRANSMIT = 0x4
CMD_TRANSCEIVE = 0xC
CMD_MF_AUTHENT = 0xE
CMD_SOFT_RESET = 0xF

PICC_REQA = 0x26
PICC_WUPA = 0x52
PICC_SEL_CL1 = 0x93
PICC_HLTA = 0x50


class _Picc:
    """The tag in the field, as far as ISO 14443-A activation goes (Picc in
    spi.ts): REQA / WUPA, cascade-level-1 anticollision and SELECT, HLTA."""

    def __init__(self, uid) -> None:
        self.state = 'idle'
        self.uid = uid

    def _bcc(self) -> int:
        out = 0
        for b in self.uid:
            out ^= b
        return out

    def receive(self, frame: list, last_bits: int):
        if len(frame) == 1 and last_bits == 7:
            cmd = frame[0] & 0x7F
            wakes = ((cmd == PICC_REQA and self.state == 'idle')
                     or (cmd == PICC_WUPA and self.state in ('idle', 'halt')))
            if wakes:
                self.state = 'ready'
                return [0x04, 0x00]
            if self.state != 'halt':
                self.state = 'idle'
            return None
        if frame and frame[0] == PICC_SEL_CL1 and len(frame) >= 2 and self.state == 'ready':
            nvb = frame[1]
            full = list(self.uid) + [self._bcc()]
            if nvb == 0x70 and len(frame) >= 9:
                same = all(frame[2 + i] == b for i, b in enumerate(full))
                crc = crc_a(frame[0:7])
                if not same or frame[7] != (crc & 0xFF) or frame[8] != crc >> 8:
                    return None
                self.state = 'active'
                sak = 0x08
                sc = crc_a([sak])
                return [sak, sc & 0xFF, sc >> 8]
            known_bits = max(0, ((nvb >> 4) - 2) * 8 + (nvb & 0x07))
            if known_bits >= 32:
                return None
            return full[known_bits // 8:]
        if (len(frame) >= 2 and frame[0] == PICC_HLTA and frame[1] == 0x00
                and self.state == 'active'):
            self.state = 'halt'
            return None
        if self.state != 'halt':
            self.state = 'idle'
        return None


class Mfrc522(_SpiChip):
    """MFRC522 (miguelbalboa MFRC522 library, SPI mode 0): the register file
    the library polls, the 64-byte FIFO, the CRC_A coprocessor, and Transceive
    against the tag of the panel (`card` present, `tag` choice), with TimerIRq
    when nothing answers."""

    def __init__(self) -> None:
        self._values: dict = {}
        self._regs = [0] * 0x40
        self._fifo: list = []
        self._pos = 0
        self._addr = 0
        self._reading = False
        self._picc = None
        self._soft_reset()

    @property
    def values(self) -> dict:
        return self._values

    @values.setter
    def values(self, v: dict) -> None:
        """A new panel value set: the tag left the field, or another one came."""
        self._values = v
        present = _num(v.get('card'), 0) >= 0.5
        index = max(0, min(len(RC522_TAGS) - 1, _js_round(_num(v.get('tag'), 0))))
        uid = RC522_TAGS[index]
        if not present:
            self._picc = None
        elif self._picc is None or self._picc.uid is not uid:
            self._picc = _Picc(uid)

    def _soft_reset(self) -> None:
        self._regs = [0] * 0x40
        for a, v in _RESET.items():
            self._regs[a] = v
        self._fifo = []

    def _read_reg(self, a: int, consume: bool) -> int:
        if a == R_FIFODATA:
            if not self._fifo:
                return 0
            return self._fifo.pop(0) if consume else self._fifo[0]
        if a == R_FIFOLEVEL:
            return min(64, len(self._fifo))
        return self._regs[a]

    def _write_reg(self, a: int, v: int) -> None:
        if a == R_COMMAND:
            self._regs[a] = (self._regs[a] & 0x20) | (v & 0x3F)
            self._command(v & 0x0F)
        elif a in (R_COMIRQ, R_DIVIRQ):
            mask = v & 0x7F
            self._regs[a] = (self._regs[a] | mask if v & 0x80 else self._regs[a] & ~mask) & 0xFF
        elif a == R_FIFODATA:
            if len(self._fifo) < 64:
                self._fifo.append(v & 0xFF)
            else:
                self._regs[R_ERROR] |= 0x10  # BufferOvfl
        elif a == R_FIFOLEVEL:
            if v & 0x80:
                self._fifo = []
                self._regs[R_ERROR] &= ~0x10 & 0xFF
        elif a == R_VERSION:
            return
        elif a == R_BITFRAMING:
            self._regs[a] = v & 0xFF
            if v & 0x80 and (self._regs[R_COMMAND] & 0x0F) == CMD_TRANSCEIVE:
                self._transceive()
        else:
            self._regs[a] = v & 0xFF

    def _command(self, cmd: int) -> None:
        if cmd == CMD_SOFT_RESET:
            self._soft_reset()
        elif cmd == CMD_CALC_CRC:
            preset = (0x0000, 0x6363, 0xA671, 0xFFFF)[self._regs[R_MODE] & 0x03]
            crc = crc_a(self._fifo, preset)
            self._fifo = []
            self._regs[R_CRCRESULT_L] = crc & 0xFF
            self._regs[R_CRCRESULT_H] = crc >> 8
            self._regs[R_DIVIRQ] |= 0x04  # CRCIRq
        elif cmd == CMD_MEM:
            self._fifo = []
            self._idle()
        elif cmd == CMD_TRANSMIT:
            self._fifo = []
            self._regs[R_COMIRQ] |= 0x40  # TxIRq
            self._idle()
        elif cmd == CMD_TRANSCEIVE:
            if self._regs[R_BITFRAMING] & 0x80:
                self._transceive()
        elif cmd == CMD_MF_AUTHENT:
            # No Crypto1: the tag never answers, so the timer runs out.
            self._fifo = []
            if self._regs[R_TMODE] & 0x80:
                self._regs[R_COMIRQ] |= 0x01

    def _idle(self) -> None:
        self._regs[R_COMMAND] &= 0xF0
        self._regs[R_COMIRQ] |= 0x10  # IdleIRq

    def _transceive(self) -> None:
        last_bits = self._regs[R_BITFRAMING] & 0x07
        self._regs[R_BITFRAMING] &= 0x7F  # StartSend done
        frame = self._fifo
        self._fifo = []
        self._regs[R_ERROR] = 0
        self._regs[R_COMIRQ] |= 0x40  # TxIRq
        field = (self._regs[R_TXCONTROL] & 0x03) != 0
        answer = self._picc.receive(frame, last_bits) if field and self._picc is not None else None
        if answer:
            self._fifo = answer[:64]
            self._regs[R_CONTROL] &= 0xF8  # RxLastBits 0
            self._regs[R_COMIRQ] |= 0x20  # RxIRq
        elif self._regs[R_TMODE] & 0x80:
            self._regs[R_COMIRQ] |= 0x01  # TimerIRq: TAuto ran out, nothing came back

    def select(self) -> None:
        self._pos = 0

    def deselect(self) -> None:
        self._pos = 0

    def transfer(self, mosi: int) -> int:
        nxt = (mosi >> 1) & 0x3F
        first = self._pos == 0
        self._pos += 1
        if first:
            self._reading = (mosi & 0x80) != 0
            self._addr = nxt
            return 0
        if self._reading:
            out = self._read_reg(self._addr, True)
            self._addr = nxt
            return out
        self._write_reg(self._addr, mosi)
        return 0

    def peek_miso(self) -> int:
        return self._read_reg(self._addr, False) if self._pos > 0 and self._reading else 0


# Model name -> (class, the SPI mode the chip clocks in: the first of the
# descriptor's `modes` in spi.ts, which is the one the soft decoder uses).
MODELS = {
    'max6675': (Max6675, 0),
    'max31865': (Max31865, 1),
    'rc522': (Mfrc522, 0),
}


class CatalogSpiRuntime:
    """A twin dressed as the worker's WasmChipRuntime, as far as the SPI table
    (`_apply_spi_bus_map`, `_model_responder`) and the pin-watch list use it.

    The select line is the map entry's `cs`, followed from the edges the
    worker passes on (the GPIO's own, or the controller's CS when the pad
    carries it). A hardware byte goes straight to transfer(); a clock edge on
    SCK while selected goes through the software decoder below.
    """

    # Not None: the worker skips a hosted model that declares no SPI.
    spi_config = {'catalog': True}

    def __init__(self, name: str, chip: _SpiChip, mode: int, pin_map: dict, cs: dict,
                 pin_writer=None, pin_reader=None) -> None:
        self.name = name
        self.chip = chip
        self.mode = mode & 3
        self._pins = {str(k).upper(): int(v) for k, v in (pin_map or {}).items()}
        self._write = pin_writer
        self._read = pin_reader
        cs = cs or {'kind': 'none'}
        kind = cs.get('kind')
        self._cs_gpio = int(cs['gpio']) if kind in ('pin', 'hw') and cs.get('gpio') is not None else None
        self._active_low = bool(cs.get('active_low', True))
        self._selected = False
        sck = self._pins.get('SCK')
        # A clock the guest never drove reads low, as in the tab's decoder.
        self._sck_level = bool(self._read(sck)) if self._read and sck is not None else False
        self._count = 0
        self._shift_in = 0
        if kind == 'none' or (kind == 'const' and cs.get('active')):
            self._set_selected(True)

    # ── what the worker's SPI table calls ──
    @property
    def miso_pad(self):
        """The GPIO this chip drives when the guest bit-bangs it (None: not wired)."""
        return self._pins.get('MISO')

    def has_pin_watches(self) -> bool:
        return True

    def update_attrs(self, attrs: dict) -> None:
        values = dict(self.chip.values)
        values.update(attrs)
        self.chip.values = values

    def spi_transfer_byte(self, mosi: int, _handle: int = 0) -> int:
        return self.chip.transfer(mosi & 0xFF) & 0xFF

    def take_blob_dirty(self) -> dict:
        return {}

    def blob_span(self, _name: str, _lo: int, _hi: int) -> bytes:
        return b''

    def notify_pin_change(self, gpio: int, level: int) -> None:
        if gpio == self._cs_gpio:
            self._set_selected(((level & 1) == 0) == self._active_low)
        if gpio == self._pins.get('SCK'):
            self._on_sck(bool(level & 1))

    # ── selection ──
    def _set_selected(self, selected: bool) -> None:
        if selected == self._selected:
            return
        self._selected = selected
        if selected:
            self.chip.select()
        else:
            self.chip.deselect()
        # SoftSpiDecoder.restart: a new transaction starts. CPHA = 0: the first
        # bit must already be on MISO when the first sampling edge arrives.
        self._count = 0
        self._shift_in = 0
        if selected and (self.mode & 1) == 0:
            self._drive_bit()

    # ── the software decoder (buses/softSpi.ts) ──
    def _drive_bit(self) -> None:
        miso = self._pins.get('MISO')
        if miso is None or self._write is None:
            return
        out = self.chip.peek_miso() & 0xFF
        self._write(miso, (out >> (7 - self._count)) & 1)

    def _on_sck(self, level: bool) -> None:
        if level == self._sck_level:
            return
        self._sck_level = level
        if not self._selected:
            return
        cpol = (self.mode & 2) != 0
        cpha = (self.mode & 1) != 0
        leading = level != cpol
        if leading != cpha:
            mosi = self._pins.get('MOSI')
            bit = 1 if (mosi is not None and self._read is not None and self._read(mosi) == 1) else 0
            self._shift_in = ((self._shift_in << 1) | bit) & 0xFF
            self._count += 1
            if self._count == 8:
                byte = self._shift_in
                self._count = 0
                self._shift_in = 0
                self.chip.transfer(byte)
        else:
            self._drive_bit()


def _regmap_module():
    """catalog_regmap.py, as a package module or beside this file (the
    worker loads this one by path when `app.services` is not importable)."""
    try:
        return importlib.import_module('app.services.catalog_regmap')
    except ImportError:
        pass
    if 'catalog_regmap' in sys.modules:
        return sys.modules['catalog_regmap']
    path = pathlib.Path(__file__).parent / 'catalog_regmap.py'
    spec = importlib.util.spec_from_file_location('catalog_regmap', path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules['catalog_regmap'] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def catalog_spi_runtime(name: str, attrs=None, pin_map=None, cs=None, *,
                        pin_writer=None, pin_reader=None, regmap=None):
    """The runtime for a bus-map entry naming `model.catalog`, or None for a
    name with no twin here.

    `pin_map` names the module's bus legs by role (SCK, MOSI, MISO, CS), as the
    tab sends them; `pin_writer(gpio, level)` puts a bit on the guest's MISO
    pad and `pin_reader(gpio)` reads a pad's level (None: never driven).
    Name 'regmap' is the card's own register map (catalog_regmap.py), given
    as `regmap`."""
    if name == 'regmap':
        if not isinstance(regmap, dict):
            return None
        chip = _regmap_module().RegmapChip(regmap)
        mode = int(regmap.get('spiMode', 0))
    else:
        spec = MODELS.get(str(name))
        if spec is None:
            return None
        cls, mode = spec
        chip = cls()
    chip.values = {str(k): float(v) for k, v in (attrs or {}).items()
                   if isinstance(v, (int, float)) and not isinstance(v, bool)}
    return CatalogSpiRuntime(str(name), chip, mode, pin_map or {}, cs or {'kind': 'none'},
                             pin_writer=pin_writer, pin_reader=pin_reader)
