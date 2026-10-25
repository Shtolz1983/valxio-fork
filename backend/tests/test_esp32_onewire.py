"""DS18B20 on the ESP32 worker (app/services/esp32_onewire.py), driven by a
master that times its slots like OneWire's bit-banging (reset 480/70/410 us,
write 10/55 or 65/5 us, read 3/10/53 us)."""

from app.services.esp32_onewire import (
    Ds18b20Line,
    dallas_crc8,
    ds18b20_rom,
)

# The tab's model (frontend/src/partsCatalog/models/line.ts) for the same seeds.
TS_ROM = {'ds18b20_1': [40, 79, 239, 199, 147, 207, 118, 0], 'ds18b20@16': [40, 154, 0, 8, 149, 102, 63, 110]}
TS_SCRATCHPAD_MINUS_12_5 = [56, 255, 75, 70, 127, 255, 8, 16, 35]


class Master:
    def __init__(self, line: Ds18b20Line):
        self.line = line
        self.t = 0.0

    def wait(self, us: float) -> None:
        self.t += us

    def reset(self) -> bool:
        self.line.master_low(self.t)
        self.wait(480)
        self.line.master_release(self.t)
        self.wait(70)
        present = self.line.level(self.t) == 0
        self.wait(410)
        return present

    def write_bit(self, bit: int) -> None:
        self.line.master_low(self.t)
        self.wait(10 if bit else 65)
        self.line.master_release(self.t)
        self.wait(55 if bit else 5)

    def read_bit(self) -> int:
        self.line.master_low(self.t)
        self.wait(3)
        self.line.master_release(self.t)
        self.wait(10)
        r = self.line.level(self.t)
        self.wait(53)
        return r

    def write(self, byte: int) -> None:
        for i in range(8):
            self.write_bit((byte >> i) & 1)

    def read(self) -> int:
        return sum(self.read_bit() << i for i in range(8))


def test_rom_matches_the_tab_and_carries_its_crc():
    for seed, rom in TS_ROM.items():
        assert list(ds18b20_rom(seed)) == rom
        assert dallas_crc8(rom, 7) == rom[7]


def test_dallas_crc_test_vector():
    # Maxim AN27: the ROM 02 1C B8 01 00 00 00 has CRC A2.
    assert dallas_crc8([0x02, 0x1C, 0xB8, 0x01, 0x00, 0x00, 0x00]) == 0xA2


def test_convert_then_read_scratchpad_gives_the_panel_temperature():
    line = Ds18b20Line('ds18b20_1', -12.5)
    m = Master(line)
    assert m.reset()
    m.write(0xCC)
    m.write(0x44)
    # Converting: read slots answer 0 until tCONV (750 ms at 12 bits) is over.
    assert m.read_bit() == 0
    m.wait(750_000)
    assert m.read_bit() == 1
    assert m.reset()
    m.write(0xCC)
    m.write(0xBE)
    sp = [m.read() for _ in range(9)]
    assert sp == TS_SCRATCHPAD_MINUS_12_5
    raw = sp[0] | (sp[1] << 8)
    assert (raw - 0x10000 if raw & 0x8000 else raw) / 16 == -12.5


def test_search_rom_walks_the_address_and_read_rom_returns_it():
    line = Ds18b20Line('ds18b20@16', 25)
    m = Master(line)
    assert m.reset()
    m.write(0xF0)
    found = 0
    for i in range(64):
        bit, cmp = m.read_bit(), m.read_bit()
        assert bit != cmp  # one device: never a discrepancy
        found |= bit << i
        m.write_bit(bit)
    assert list(found.to_bytes(8, 'little')) == TS_ROM['ds18b20@16']
    assert m.reset()
    m.write(0x33)
    assert [m.read() for _ in range(8)] == TS_ROM['ds18b20@16']


def test_a_match_rom_for_another_device_deselects_it():
    line = Ds18b20Line('ds18b20_1', 25)
    m = Master(line)
    assert m.reset()
    m.write(0x55)
    for b in TS_ROM['ds18b20@16']:
        m.write(b)
    m.write(0xBE)
    assert [m.read() for _ in range(2)] == [0xFF, 0xFF]


def test_no_presence_without_a_reset_and_the_panel_moves_the_next_conversion():
    line = Ds18b20Line('ds18b20_1', 20)
    m = Master(line)
    assert line.level(m.t) == 1
    assert m.reset()
    m.write(0xCC)
    m.write(0x44)
    line.device.temperature_c = 30.25
    m.wait(800_000)
    assert m.reset()
    m.write(0xCC)
    m.write(0xBE)
    sp = [m.read() for _ in range(2)]
    # The conversion latched 20 C when it started.
    assert (sp[0] | (sp[1] << 8)) / 16 == 20
