"""DS18B20 on 1-Wire for the QEMU ESP32 worker.

The Python twin of the tab's line model (frontend/src/partsCatalog/models/
line.ts): `Ds18b20Device` is the protocol (ROM commands, scratchpad,
conversion), `Ds18b20Line` the wire, and the worker glue in esp32_worker.py
only reports what the guest does to the pad and asks what the sensor holds
on it.

Wire. The master (OneWire's bit-banging) opens every slot by driving the line
low. A low of 400 us or more is a reset: the sensor answers with a presence
pulse, 120 us low from 30 us after the release. Otherwise the sensor knows
from its protocol state whether the slot is a write slot (the master's low
width is the bit: shorter than 30 us is a 1) or a read slot (the sensor holds
the line low for 30 us from the master's edge to send a 0; OneWire samples it
~13 us in).

Times are guest microseconds. The worker runs the guest under -icount when a
DS18B20 is on the board (icount_shift_for_run): on host time a callback into
Python costs tens of microseconds, which would smear a 10 us write-1 into a
write-0.
"""

from __future__ import annotations

import math

RESET_MIN_US = 400.0
SAMPLE_US = 30.0
PRESENCE_WAIT_US = 30.0
PRESENCE_US = 120.0
ZERO_HOLD_US = 30.0

FAMILY = 0x28
POWER_ON_RAW = 0x0550  # +85 C


def dallas_crc8(data, length: int | None = None) -> int:
    """Dallas/Maxim CRC-8 (polynomial x^8+x^5+x^4+1, reflected 0x8C)."""
    crc = 0
    for b in list(data)[: len(data) if length is None else length]:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc


def _imul(a: int, b: int) -> int:
    """JavaScript Math.imul followed by >>> 0."""
    return (a * b) & 0xFFFFFFFF


def ds18b20_rom(seed: str) -> bytes:
    """Family 0x28, a 48-bit serial hashed from `seed` (the tab hashes the
    component id the same way, so both answer with one address), CRC."""
    h, h2 = 0x811C9DC5, 0x01000193
    for ch in seed:
        c = ord(ch) & 0xFFFF
        h = _imul(h ^ c, 0x01000193)
        h2 = _imul(h2 ^ c, 0x5BD1E995)
    rom = bytearray(8)
    rom[0] = FAMILY
    for i in range(4):
        rom[1 + i] = (h >> (8 * i)) & 0xFF
    rom[5] = h2 & 0xFF
    rom[6] = (h2 >> 8) & 0xFF
    rom[7] = dallas_crc8(rom, 7)
    return bytes(rom)


def resolution(config: int) -> int:
    return 9 + ((config >> 5) & 3)


def conversion_us(res: int) -> float:
    return 750_000 / (1 << (12 - res))


def raw_temperature(temperature_c: float, res: int = 12) -> int:
    t = max(-55.0, min(125.0, temperature_c))
    shift = 12 - res
    raw = int(math.floor(t * (16 >> shift) + 0.5)) << shift
    return raw & 0xFFFF


def scratchpad(raw: int, th: int, tl: int, config: int, byte6: int) -> bytes:
    sp = bytearray([raw & 0xFF, (raw >> 8) & 0xFF, th & 0xFF, tl & 0xFF, config & 0xFF, 0xFF, byte6 & 0xFF, 0x10, 0])
    sp[8] = dallas_crc8(sp, 8)
    return bytes(sp)


class Ds18b20Device:
    """The protocol, at the slot level (Ds18b20Device in line.ts)."""

    def __init__(self, rom: bytes, temperature_c: float):
        self.rom = rom
        self.temperature_c = temperature_c
        self.eeprom = (0x4B, 0x46, 0x7F)
        self.power_on()

    def power_on(self) -> None:
        self.raw = POWER_ON_RAW
        self.byte6 = 0x0C
        self.th, self.tl, self.config = self.eeprom
        self.phase = 'idle'
        self.busy_until = -math.inf
        self.convert_until = -math.inf
        self.pending_raw: int | None = None
        self._clear_rx()
        self.tx: list = []
        self.tx_index = 0
        self.tx_then: str | None = None
        self.search_bit = 0
        self.search_step = 0

    def _clear_rx(self) -> None:
        self.rx_byte = 0
        self.rx_bits = 0
        self.rx_bytes: list = []

    def bus_reset(self) -> None:
        self.phase = 'rom'
        self._clear_rx()
        self.tx = []
        self.tx_index = 0

    def slot_start(self, now: float):
        """True: the sensor holds the line low (sends 0); False: it leaves it
        (sends 1, or is deselected); None: it listens (a write slot)."""
        self._finish_conversion(now)
        p = self.phase
        if p in ('rom', 'match', 'function', 'writeScratch'):
            return None
        if p == 'search':
            if self.search_step == 2:
                return None
            bit = self._rom_bit(self.search_bit)
            sent = bit if self.search_step == 0 else bit ^ 1
            self.search_step += 1
            return sent == 0
        if p == 'send':
            bit = self.tx[self.tx_index] if self.tx_index < len(self.tx) else 1
            self.tx_index += 1
            if self.tx_index >= len(self.tx) and self.tx_then:
                self.phase = self.tx_then
                self.tx_then = None
            return bit == 0
        if p == 'busy':
            return now < self.busy_until
        return False

    def write_bit(self, bit: int, now: float) -> None:
        if self.phase == 'search':
            if bit != self._rom_bit(self.search_bit):
                self.phase = 'idle'
                return
            self.search_step = 0
            self.search_bit += 1
            if self.search_bit == 64:
                self.phase = 'function'
            return
        self.rx_byte |= (bit & 1) << self.rx_bits
        self.rx_bits += 1
        if self.rx_bits < 8:
            return
        byte = self.rx_byte
        self.rx_byte = 0
        self.rx_bits = 0
        self._on_byte(byte, now)

    def _on_byte(self, byte: int, now: float) -> None:
        p = self.phase
        if p == 'rom':
            self._rom_command(byte)
        elif p == 'match':
            self.rx_bytes.append(byte)
            if len(self.rx_bytes) == 8:
                self.phase = 'function' if bytes(self.rx_bytes) == self.rom else 'idle'
                self.rx_bytes = []
        elif p == 'writeScratch':
            self.rx_bytes.append(byte)
            if len(self.rx_bytes) == 3:
                self.th, self.tl = self.rx_bytes[0], self.rx_bytes[1]
                self.config = (self.rx_bytes[2] & 0x60) | 0x1F
                self.rx_bytes = []
                self.phase = 'idle'
        elif p == 'function':
            self._function_command(byte, now)

    def _rom_command(self, cmd: int) -> None:
        if cmd == 0x33:
            self._send(self.rom, 'function')
        elif cmd == 0x55:
            self.phase = 'match'
            self.rx_bytes = []
        elif cmd == 0xCC:
            self.phase = 'function'
        elif cmd == 0xF0:
            self._start_search()
        elif cmd == 0xEC:
            if self._alarm():
                self._start_search()
            else:
                self.phase = 'idle'
        else:
            self.phase = 'idle'

    def _function_command(self, cmd: int, now: float) -> None:
        res = resolution(self.config)
        if cmd == 0x44:
            self.pending_raw = raw_temperature(self.temperature_c, res)
            self.convert_until = now + conversion_us(res)
            self.busy_until = self.convert_until
            self.phase = 'busy'
        elif cmd == 0xBE:
            self._finish_conversion(now)
            self._send(self.scratchpad(), None)
        elif cmd == 0x4E:
            self.phase = 'writeScratch'
            self.rx_bytes = []
        elif cmd == 0x48:
            self.eeprom = (self.th, self.tl, self.config)
            self.busy_until = now + 10_000
            self.phase = 'busy'
        elif cmd == 0xB8:
            self.th, self.tl, self.config = self.eeprom
            self.busy_until = now
            self.phase = 'busy'
        elif cmd == 0xB4:
            self.phase = 'power'
        else:
            self.phase = 'idle'

    def scratchpad(self) -> bytes:
        return scratchpad(self.raw, self.th, self.tl, self.config, self.byte6)

    def _finish_conversion(self, now: float) -> None:
        if self.pending_raw is None or now < self.convert_until:
            return
        self.raw = self.pending_raw
        self.byte6 = 0x10 - (self.raw & 0x0F)
        self.pending_raw = None

    def _send(self, data: bytes, then: str | None) -> None:
        self.tx = [(b >> i) & 1 for b in data for i in range(8)]
        self.tx_index = 0
        self.tx_then = then
        self.phase = 'send'

    def _start_search(self) -> None:
        self.phase = 'search'
        self.search_bit = 0
        self.search_step = 0

    def _rom_bit(self, i: int) -> int:
        return (self.rom[i >> 3] >> (i & 7)) & 1

    def _alarm(self) -> bool:
        t = self.raw - 0x10000 if self.raw & 0x8000 else self.raw
        t >>= 4
        th = self.th - 0x100 if self.th & 0x80 else self.th
        tl = self.tl - 0x100 if self.tl & 0x80 else self.tl
        return t >= th or t <= tl


class Ds18b20Line:
    """The sensor on the wire: told when the master pulls the line low and
    lets it go, asked what level it holds at a read."""

    def __init__(self, seed: str, temperature_c: float):
        self.device = Ds18b20Device(ds18b20_rom(seed), temperature_c)
        self._low_at: float | None = None
        self._listening = False
        self._presence = (-math.inf, -math.inf)
        self._hold_until = -math.inf

    def master_low(self, now: float) -> None:
        self._low_at = now
        self._listening = False
        if self._presence[0] <= now < self._presence[1]:
            return
        answer = self.device.slot_start(now)
        if answer is None:
            self._listening = True
        self._hold_until = now + ZERO_HOLD_US if answer else -math.inf

    def master_release(self, now: float) -> None:
        if self._low_at is None:
            return
        width = now - self._low_at
        self._low_at = None
        if width >= RESET_MIN_US:
            self.device.bus_reset()
            self._listening = False
            self._hold_until = -math.inf
            start = now + PRESENCE_WAIT_US
            self._presence = (start, start + PRESENCE_US)
            return
        if self._listening:
            self.device.write_bit(1 if width < SAMPLE_US else 0, now)
        self._listening = False

    def level(self, now: float) -> int:
        """0 while the sensor pulls the line low, else 1 (the pull-up)."""
        if self._presence[0] <= now < self._presence[1] or now < self._hold_until:
            return 0
        return 1

    def power_on(self) -> None:
        self.device.power_on()
        self._low_at = None
        self._listening = False
        self._presence = (-math.inf, -math.inf)
        self._hold_until = -math.inf
