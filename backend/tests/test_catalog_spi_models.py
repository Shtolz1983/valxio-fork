"""Parts-catalog SPI chips on the ESP32 worker (app/services/catalog_spi_models.py).

Each scenario below is the traffic the card's library clocks (plus the edges
around it), as ops on the tab's SpiDevice shape: `v` sets the panel values,
`s` / `d` select and deselect, `x` transfers a byte, `p` peeks MISO. The
expected answers (TS_OUT) were produced by the tab's TypeScript models
(frontend/src/partsCatalog/models/spi.ts) replaying the same ops: the worker's
twins must answer a guest exactly as the tab answers an Uno.

The runtime tests drive CatalogSpiRuntime the way the worker does: CS and SCK
edges through notify_pin_change, MISO read back from the pin writer, so the
bit-banged MAX6675 read is decoded here exactly as buses/softSpi.ts does.
"""

from app.services.catalog_spi_models import (
    MODELS,
    catalog_spi_runtime,
    crc_a,
    max6675_word,
    max31865_library_celsius,
    max31865_raw,
)


# ── Scenarios ────────────────────────────────────────────────────────────────

def _max6675_ops() -> list:
    ops: list = []
    for t in (25, 432.75, 1023.75, 2000, -5, 0.125, 0.375, 99.9):
        ops += [['v', {'temperature': t}], ['s'], ['p'], ['x', 0], ['p'], ['x', 0], ['x', 0], ['d']]
    # A value moved between two reads with no select in between: the word is
    # latched at the first byte of a frame.
    ops += [['s'], ['x', 0], ['v', {'temperature': 50}], ['x', 0], ['d'], ['s'], ['x', 0], ['x', 0], ['d']]
    return ops


def _max31865_ops() -> list:
    ops: list = []

    def wr(reg, *vals):
        ops.extend([['s'], ['x', 0x80 | reg]] + [['x', v] for v in vals] + [['d']])

    def rd(reg, n):
        ops.extend([['s'], ['x', reg & 0x7F]])
        for _ in range(n):
            ops.extend([['p'], ['x', 0xFF]])
        ops.append(['d'])

    # begin(): wires, bias off, auto off, thresholds 0..0xFFFF, clear fault.
    rd(0, 1)
    wr(0, 0x00)
    wr(3, 0xFF, 0xFF, 0x00, 0x00)
    rd(3, 4)
    wr(0, 0x02)
    for t in (25, -78.5, 600, 850, 900, -200, -250, 0, -0.5):
        ops.append(['v', {'temperature': t}])
        # readRTD(): clearFault, enableBias, 1-shot, read RTD, bias off.
        rd(0, 1)
        wr(0, 0x02)
        wr(0, 0x80)
        wr(0, 0xA0)
        rd(1, 2)
        rd(7, 1)
        wr(0, 0x00)
    # Thresholds that the RTD crosses: high fault, then low fault.
    wr(3, 0x40, 0x00, 0x30, 0x00)
    ops.append(['v', {'temperature': 600}])
    wr(0, 0xA0)
    rd(0, 8)
    wr(0, 0x02)
    rd(0, 8)
    ops.append(['v', {'temperature': -150}])
    wr(0, 0xA0)
    rd(1, 2)
    rd(7, 1)
    # Auto mode converts on every RTD read.
    wr(3, 0xFF, 0xFF, 0x00, 0x00)
    wr(0, 0x02)
    wr(0, 0xC0)
    ops.append(['v', {'temperature': 123.4}])
    rd(1, 2)
    ops.append(['v', {'temperature': 321}])
    rd(1, 3)
    # Read-only registers ignore writes; the address wraps through 0x7F.
    wr(1, 0x12, 0x34)
    wr(7, 0x55)
    rd(0x7E, 4)
    return ops


R = {'Command': 0x01, 'ComIrq': 0x04, 'DivIrq': 0x05, 'Error': 0x06, 'FIFOData': 0x09,
     'FIFOLevel': 0x0A, 'Control': 0x0C, 'BitFraming': 0x0D, 'Coll': 0x0E, 'Mode': 0x11,
     'TxMode': 0x12, 'RxMode': 0x13, 'TxControl': 0x14, 'TxASK': 0x15, 'CRCResultH': 0x21,
     'CRCResultL': 0x22, 'ModWidth': 0x24, 'TMode': 0x2A, 'TPrescaler': 0x2B,
     'TReloadH': 0x2C, 'TReloadL': 0x2D, 'Version': 0x37}

UID0 = [0xDE, 0xAD, 0xBE, 0xEF]


def _rc522_ops() -> list:
    ops: list = []

    def wr(name, *vals):
        ops.extend([['s'], ['x', R[name] << 1]] + [['x', v] for v in vals] + [['d']])

    def rd(name, n=1):
        a = 0x80 | (R[name] << 1)
        ops.extend([['s'], ['x', a]])
        for i in range(n):
            ops.extend([['p'], ['x', a if i < n - 1 else 0]])
        ops.append(['d'])

    def transceive(data, bits=0):
        wr('Command', 0x00)
        wr('ComIrq', 0x7F)
        wr('FIFOLevel', 0x80)
        wr('FIFOData', *data)
        wr('BitFraming', bits)
        wr('Command', 0x0C)
        rd('BitFraming')
        wr('BitFraming', 0x80 | bits)
        rd('ComIrq')
        rd('Error')
        rd('FIFOLevel')
        rd('FIFOData', 5)
        rd('Control')

    def calc_crc(data):
        wr('Command', 0x00)
        wr('DivIrq', 0x04)
        wr('FIFOLevel', 0x80)
        wr('FIFOData', *data)
        wr('Command', 0x03)
        rd('DivIrq')
        wr('Command', 0x00)
        rd('CRCResultL')
        rd('CRCResultH')

    def framed(data):
        c = crc_a(data)
        return list(data) + [c & 0xFF, c >> 8]

    ops.append(['v', {'card': 0, 'tag': 0}])
    # PCD_Init()
    wr('Command', 0x0F)
    rd('Command')
    for name, v in (('TxMode', 0), ('RxMode', 0), ('ModWidth', 0x26), ('TMode', 0x80),
                    ('TPrescaler', 0xA9), ('TReloadH', 0x03), ('TReloadL', 0xE8),
                    ('TxASK', 0x40), ('Mode', 0x3D)):
        wr(name, v)
    rd('TxControl')
    wr('TxControl', 0x83)
    rd('Version')
    # No tag: REQA times out.
    transceive([0x26], 7)
    # A tag: REQA, anticollision, SELECT, HLTA.
    ops.append(['v', {'card': 1, 'tag': 0}])
    transceive([0x26], 7)
    wr('Coll', 0x80)
    transceive([0x93, 0x20])
    calc_crc([0x93, 0x70] + UID0 + [0x22])
    transceive(framed([0x93, 0x70] + UID0 + [0x22]))
    calc_crc([0x50, 0x00])
    transceive(framed([0x50, 0x00]))
    # Halted: REQA leaves it alone, WUPA wakes it.
    transceive([0x26], 7)
    transceive([0x52], 7)
    # A bad CRC on SELECT gets no answer.
    transceive([0x93, 0x20])
    transceive([0x93, 0x70] + UID0 + [0x22, 0x00, 0x00])
    # Another tag; partial anticollision (NVB 0x31: 1 byte + 1 bit known).
    ops.append(['v', {'card': 1, 'tag': 1}])
    transceive([0x26], 7)
    transceive([0x93, 0x31, 0x12])
    # The antenna off: nothing answers.
    wr('TxControl', 0x80)
    transceive([0x52], 7)
    wr('TxControl', 0x83)
    # MFAuthent, Mem and Transmit, the CRC presets, a FIFO overflow.
    wr('Command', 0x0E)
    rd('ComIrq')
    wr('Command', 0x01)
    rd('ComIrq')
    wr('Command', 0x04)
    rd('ComIrq')
    for preset in (0x3C, 0x3E, 0x3F):
        wr('Mode', preset)
        calc_crc([0x01, 0x02, 0x03])
    wr('FIFOLevel', 0x80)
    wr('FIFOData', *range(70))
    rd('Error')
    rd('FIFOLevel')
    wr('FIFOLevel', 0x80)
    rd('Error')
    wr('Version', 0x00)
    rd('Version')
    ops.append(['v', {'card': 0, 'tag': 1}])
    transceive([0x26], 7)
    ops.append(['v', {'card': 1, 'tag': 3.6}])
    transceive([0x26], 7)
    transceive([0x93, 0x20])
    return ops


SCENARIOS = {'max6675': _max6675_ops, 'max31865': _max31865_ops, 'rc522': _rc522_ops}


def replay(name: str, ops: list) -> list:
    """The answers of the twin for `ops` (x and p only), as the TS replay
    records them."""
    rt = catalog_spi_runtime(name)
    chip = rt.chip
    out = []
    for op in ops:
        kind = op[0]
        if kind == 'v':
            chip.values = dict(op[1])
        elif kind == 's':
            chip.select()
        elif kind == 'd':
            chip.deselect()
        elif kind == 'x':
            out.append(chip.transfer(op[1]) & 0xFF)
        elif kind == 'p':
            out.append(chip.peek_miso() & 0xFF)
    return out


# The TypeScript models' answers for SCENARIOS, as hex.
TS_OUT = {
    'max6675': (
        '030320200036361818007f7ff8f8007f7ff8f8000000000000000008080000001010000c0c80'
        '80000c800640'
    ),
    'max31865': (
        '0000000000000000000000ffffffff0000000000000000000000000000000041415454000000'
        '00000000000000000000000029290a0a000000000000000000000000000000babac4c4000000'
        '000000000000000000000000e8e87878000000000000000000000000000000e8e87878000000'
        '0000000000000000000000000b0b06060000000000000000000000000000000b0b0606000000'
        '0000000000000000000000003b3b88880000000000000000000000000000003b3b6c6c000000'
        '000000000000000000008080babac5c5404000003030000080800000000000babac4c4404000'
        '003030000000000000001717a7a7004040000000000000000000001757baba005782aeaeffff'
        '00000000000000000000c0c08282'
    ),
    'rc522': (
        '0000002020000000000000000000000000000000000000008080000000929200000000000000'
        '0000000000000707000000414100000000000000000000000000000000000010100000000000'
        '0000000000000000070700000060600000000002020004040000000000000000001010000000'
        '000000000000000000000000000000000000606000000000050500dedeadadbebeefef222200'
        '101000000000000000000000000000000000000404000000b9b9009c9c000000000000000000'
        '00000000000000000000000000000000006060000000000303000808b6b6dddd000000000010'
        '100000000000000000000000000404000000575700cdcd000000000000000000000000000000'
        '0000000000004141000000000000000000000000000000000000101000000000000000000000'
        '0000000707000000414100000000000000000000000000000000000010100000000000000000'
        '0000000000070700000060600000000002020004040000000000000000001010000000000000'
        '00000000000000000000000000606000000000050500dedeadadbebeefef2222001010000000'
        '0000000000000000000000000000000000000000000000414100000000000000000000000000'
        '0000000000101000000000000000000000000000070700000060600000000002020004040000'
        '0000000000000010100000000000000000000000000000000000000000606000000000040400'
        '3434565678780808000000101000000000000000000000000000000007070000004141000000'
        '0000000000000000000000000000001010000000000041410000005151000000515100000000'
        '00000000000000000000000404000000f7f7005b5b0000000000000000000000000000000404'
        '000000dcdc007a7a0000000000000000000000000000000404000000c4c40062620000000000'
        '0000000000000000000000000000000000000000000000000000000000000000000000000000'
        '0000000000000000000000000000000000000000000000000000000000000010100040400000'
        '0000000000009292000000000000000000000000000707000000414100000000000000000000'
        '0000000000000000101000000000000000000000000000070700000060600000000002020004'
        '0400000000000000000010100000000000000000000000000000000000000060600000000005'
        '050004047f7f3a3a9191d0d0001010'
    ),
}


def test_every_model_has_a_scenario():
    assert set(MODELS) == set(SCENARIOS)


def test_twins_answer_exactly_as_the_tab_models():
    for name, build in SCENARIOS.items():
        assert bytes(replay(name, build())).hex() == TS_OUT[name], name


# ── Helpers against the tab's own unit vectors ──────────────────────────────

def test_max6675_word():
    assert max6675_word(25) == 100 << 3
    assert max6675_word(1023.75) == 4095 << 3
    assert max6675_word(-5) == 0
    assert max6675_word(0.125) == 1 << 3  # Math.round: halves go up


def test_max31865_code_decodes_to_the_panel_temperature():
    for t in (-200, -40, -0.5, 0, 25, 100, 400, 850):
        assert abs(max31865_library_celsius(max31865_raw(t)) - t) < 0.05


def test_crc_a_matches_the_iso_vector():
    assert crc_a([0x08]) == 0xDDB6
    assert crc_a([0x00, 0x00]) == 0x1EA0


# ── The runtime as the worker drives it ─────────────────────────────────────

SCK, MISO, CS = 25, 26, 27


class Pads:
    """The guest's pads: what the worker's pin reader and writer see."""

    def __init__(self):
        self.level: dict = {}
        self.driven: list = []

    def write(self, gpio, level):
        self.level[gpio] = level
        self.driven.append((gpio, level))

    def read(self, gpio):
        return self.level.get(gpio)


def _soft_runtime(name, values, pads):
    return catalog_spi_runtime(
        name, values, {'SCK': SCK, 'MISO': MISO, 'CS': CS},
        {'kind': 'pin', 'gpio': CS, 'active_low': True},
        pin_writer=pads.write, pin_reader=pads.read)


def _guest_pin(rt, pads, gpio, level):
    pads.level[gpio] = level
    rt.notify_pin_change(gpio, level)


def max6675_read(rt, pads) -> float:
    """MAX6675::readCelsius() of the Adafruit library, as the guest runs it:
    CS low, 16 x (SCK low, read SO, SCK high), CS high."""
    _guest_pin(rt, pads, CS, 0)
    v = 0
    for _ in range(16):
        _guest_pin(rt, pads, SCK, 0)
        v = (v << 1) | (pads.read(MISO) or 0)
        _guest_pin(rt, pads, SCK, 1)
    _guest_pin(rt, pads, CS, 1)
    if v & 0x4:
        return float('nan')
    return (v >> 3) * 0.25


def test_bit_banged_max6675_reads_the_panel_and_follows_a_change():
    pads = Pads()
    rt = _soft_runtime('max6675', {'temperature': 25}, pads)
    _guest_pin(rt, pads, CS, 1)
    assert max6675_read(rt, pads) == 25.0
    rt.update_attrs({'temperature': 432.75})
    assert max6675_read(rt, pads) == 432.75
    assert max6675_read(rt, pads) == 432.75
    assert rt.miso_pad == MISO


def test_a_deselected_max6675_leaves_miso_alone_on_clock_edges():
    pads = Pads()
    rt = _soft_runtime('max6675', {'temperature': 25}, pads)
    _guest_pin(rt, pads, CS, 1)
    for level in (0, 1, 0, 1):
        _guest_pin(rt, pads, SCK, level)
    assert pads.driven == []


def test_hardware_bytes_follow_the_select_line():
    """MAX31865 on the SPI peripheral, CS a GPIO: a write, a 1-shot, then the
    RTD read decode to the panel temperature."""
    pads = Pads()
    rt = catalog_spi_runtime('max31865', {'temperature': -78.5},
                             {'SCK': 18, 'MOSI': 23, 'MISO': 19, 'CS': 5},
                             {'kind': 'pin', 'gpio': 5, 'active_low': True},
                             pin_writer=pads.write, pin_reader=pads.read)

    def frame(*mosi):
        rt.notify_pin_change(5, 0)
        out = [rt.spi_transfer_byte(b) for b in mosi]
        rt.notify_pin_change(5, 1)
        return out

    frame(0x80, 0xA0)
    hi, lo = frame(0x01, 0xFF, 0xFF)[1:]
    raw = ((hi << 8) | lo) >> 1
    assert abs(max31865_library_celsius(raw) + 78.5) < 0.05
    rt.update_attrs({'temperature': 600})
    frame(0x80, 0xA0)
    hi, lo = frame(0x01, 0xFF, 0xFF)[1:]
    assert abs(max31865_library_celsius(((hi << 8) | lo) >> 1) - 600) < 0.05


def test_rc522_panel_update_keeps_the_tag_state_for_the_same_uid():
    rt = catalog_spi_runtime('rc522', {'card': 1, 'tag': 0})
    picc = rt.chip._picc
    rt.update_attrs({'card': 1})
    assert rt.chip._picc is picc
    rt.update_attrs({'tag': 2})
    assert rt.chip._picc is not picc and rt.chip._picc.uid == (0xA1, 0xB2, 0xC3, 0xD4)
    rt.update_attrs({'card': 0})
    assert rt.chip._picc is None


def test_unknown_model_is_not_hosted():
    assert catalog_spi_runtime('nope') is None
