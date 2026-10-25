"""Register-file catalog chips on the ESP32 worker (app/services/catalog_i2c_simple.py).

The byte vectors below were produced by the tab's TypeScript models
(frontend/src/partsCatalog/models/i2cSimple.ts) for the same traffic, the
tab's way: a write phase, a repeated START, a read phase. The worker's twins
must answer a guest exactly so, both when QEMU ends the write phase with a
FINISH before the repeated START (as it does) and when it does not.
"""

import math

from app.services.catalog_i2c_models import (
    MODELS,
    I2C_FINISH,
    I2C_READ,
    I2C_START_RECV,
    I2C_START_SEND,
    I2C_WRITE,
    catalog_slave,
)
from app.services.catalog_i2c_simple import Qmc5883l, smbus_pec

SCENARIOS = {
    'adxl345': ('adxl345', 0x53, [
        ('v', {'accelX': 0.5, 'accelY': -1, 'accelZ': 2}),
        ('r', [0x00], 1),
        ('r', [0x32], 6),
        ('w', [0x2D, 0x08]),
        ('w', [0x31, 0x0B]),
        ('r', [0x32], 6),
        ('r', [0x30], 1),
        ('w', [0x31, 0x00]),
        ('v', {'accelX': 3, 'accelY': -0.5, 'accelZ': 1}),
        ('r', [0x32], 6),
        ('w', [0x31, 0x0F]),
        ('r', [0x32], 6),
        ('w', [0x1E, 0x05, 0xFB]),
        ('w', [0x31, 0x09]),
        ('r', [0x32], 6),
        ('r', [0x1E], 3),
        ('w', [0x2D, 0x00]),
        ('v', {'accelX': -7.3, 'accelY': 0.01, 'accelZ': -1.234}),
        ('r', [0x32], 6),
        ('w', [0x2D, 0x08]),
        ('r', [0x32], 8),
        ('r', [0x3F], 3),
    ]),
    'ina219': ('ina219', 0x40, [
        ('v', {'busVoltage': 5, 'current': 100}),
        ('r', [0x00], 2),
        ('r', [0x04], 2),
        ('r', [0x01], 2),
        ('w', [0x05, 0x10, 0x00]),
        ('w', [0x00, 0x39, 0x9F]),
        ('r', [0x02], 2),
        ('r', [0x01], 2),
        ('r', [0x03], 2),
        ('r', [0x04], 2),
        ('r', [0x05], 2),
        ('v', {'busVoltage': 12, 'current': -250}),
        ('w', [0x05, 0x20, 0x00]),
        ('r', [0x02], 2),
        ('r', [0x01], 2),
        ('r', [0x03], 2),
        ('r', [0x04], 2),
        ('w', [0x00, 0x01, 0x9F]),
        ('r', [0x01], 2),
        ('r', [0x04], 2),
        ('w', [0x00, 0x01, 0x98]),
        ('v', {'busVoltage': 3.3, 'current': 7.77}),
        ('r', [0x01], 2),
        ('r', [0x02], 2),
        ('w', [0x00, 0x80, 0x00]),
        ('r', [0x00], 2),
        ('r', [0x05], 2),
        ('v', {'busVoltage': 40, 'current': 5000}),
        ('w', [0x05, 0xFF, 0xFF]),
        ('r', [0x02], 2),
        ('r', [0x03], 2),
        ('r', [0x04], 2),
        ('r', [0x06], 4),
    ]),
    'mlx90614': ('mlx90614', 0x5A, [
        ('v', {'ambientTemp': 25, 'objectTemp': 36.5}),
        ('r', [0x06], 3),
        ('r', [0x07], 3),
        ('r', [0x08], 3),
        ('r', [0x04], 3),
        ('r', [0x24], 3),
        ('r', [0x2E], 3),
        ('r', [0x3C], 3),
        ('v', {'ambientTemp': -10, 'objectTemp': 250}),
        ('r', [0x06], 3),
        ('r', [0x07], 3),
        ('r', [0x05], 3),
        ('w', [0x24, 0xFF, 0x7F, 0x00]),
        ('r', [0x24], 3),
        ('w', [0x24, 0xFF, 0x7F, 0x85]),
        ('r', [0x24], 3),
        ('r', [0x09], 4),
    ]),
    'qmc5883l': ('qmc5883l', 0x0D, [
        ('v', {'heading': 0}),
        ('r', [0x0D], 1),
        ('r', [0x00], 9),
        ('w', [0x0B, 0x01]),
        ('w', [0x09, 0x1D]),
        ('r', [0x00], 9),
        ('v', {'heading': 90}),
        ('r', [0x00], 6),
        ('v', {'heading': 270}),
        ('r', [0x00], 6),
        ('v', {'heading': 180}),
        ('r', [0x00], 6),
        ('v', {'heading': 45.5}),
        ('r', [0x00], 6),
        ('v', {'heading': -30}),
        ('r', [0x00], 6),
        ('w', [0x09, 0x0D]),
        ('v', {'heading': 123}),
        ('r', [0x00], 7),
        ('w', [0x09, 0x00]),
        ('v', {'heading': 200}),
        ('r', [0x00], 7),
        ('r', [0x09], 3),
        ('w', [0x0A, 0x80]),
        ('r', [0x09], 3),
        ('r', [0x00], 7),
    ]),
    'ccs811 clock': ('ccs811', 0x5A, [
        ('v', {'eco2': 800, 'tvoc': 100}),
        ('r', [0x20], 1),
        ('r', [0x00], 1),
        ('r', [0x02], 8),
        ('r', [0x00], 1),
        ('r', [0xE0], 1),
        ('w', [0xF4]),
        ('r', [0x00], 1),
        ('w', [0x01, 0x10]),
        ('r', [0x00], 1),
        ('t', 999_999_999),
        ('r', [0x00], 1),
        ('t', 1_000_000_000),
        ('r', [0x00], 1),
        ('r', [0x02], 8),
        ('r', [0x00], 1),
        ('t', 3_500_000_000),
        ('r', [0x00], 1),
        ('v', {'eco2': 1200, 'tvoc': 250}),
        ('r', [0x02], 8),
        ('r', [0x00], 1),
        ('r', [0x01], 1),
        ('r', [0x03], 2),
        ('r', [0x06], 4),
        ('r', [0x11], 2),
        ('r', [0x21], 1),
        ('r', [0x23], 2),
        ('r', [0x24], 2),
        ('w', [0x11, 0x12, 0x34]),
        ('r', [0x11], 2),
        ('w', [0x05, 0x64, 0x00, 0x64, 0x00]),
        ('r', [0x00], 1),
        ('r', [0x07], 2),
        ('r', [0x00], 1),
        ('r', [0xE0], 1),
        ('w', [0x01, 0x40]),
        ('t', 3_600_000_000),
        ('r', [0x00], 1),
        ('t', 3_750_000_000),
        ('r', [0x00], 1),
        ('r', [0x02], 8),
        ('w', [0x01, 0x50]),
        ('r', [0xE0], 1),
        ('w', [0x01, 0x00]),
        ('t', 9_000_000_000),
        ('r', [0x00], 1),
        ('w', [0xFF, 0x11, 0xE5, 0x72, 0x8A]),
        ('r', [0x00], 1),
        ('r', [0x02], 2),
        ('w', [0x10]),
        ('r', [0xE0], 1),
    ]),
    'ccs811 no clock': ('ccs811', 0x5A, [
        ('v', {'eco2': 650, 'tvoc': 42}),
        ('w', [0xFF, 0x11, 0xE5, 0x72, 0x8A]),
        ('r', [0x20], 1),
        ('w', [0xF4]),
        ('r', [0x00], 1),
        ('w', [0x01, 0x10]),
        ('r', [0x00], 1),
        ('r', [0x02], 8),
        ('r', [0x00], 1),
        ('r', [0x02], 8),
        ('w', [0x01, 0x10]),
        ('r', [0x00], 1),
    ]),
}

TS_BYTES = {
    'adxl345': [
        [229],
        [0, 0, 0, 0, 0, 0],
        [125, 0, 6, 255, 244, 1],
        [130],
        [255, 1, 131, 255, 250, 0],
        [112, 23, 24, 252, 208, 7],
        [2, 3, 112, 255, 250, 0],
        [5, 251, 0],
        [2, 3, 112, 255, 250, 0],
        [0, 252, 239, 255, 204, 254, 0, 0],
        [0, 229, 0],
    ],
    'ina219': [
        [57, 159],
        [0, 0],
        [3, 232],
        [39, 18],
        [3, 232],
        [0, 250],
        [3, 232],
        [16, 0],
        [93, 194],
        [246, 60],
        [11, 184],
        [236, 120],
        [246, 60],
        [236, 120],
        [246, 60],
        [93, 194],
        [57, 159],
        [0, 0],
        [250, 3],
        [0, 0],
        [0, 0],
        [0, 0, 0, 0],
    ],
    'mlx90614': [
        [59, 58, 216],
        [122, 60, 146],
        [122, 60, 64],
        [204, 1, 42],
        [255, 255, 214],
        [90, 190, 211],
        [52, 18, 246],
        [101, 51, 61],
        [46, 102, 75],
        [160, 40, 234],
        [255, 255, 214],
        [255, 127, 95],
        [0, 0, 194, 255],
    ],
    'qmc5883l': [
        [255],
        [0, 0, 0, 0, 0, 0, 0, 196, 9],
        [132, 3, 8, 0, 80, 251, 1, 196, 9],
        [248, 255, 132, 3, 80, 251],
        [248, 255, 124, 252, 80, 251],
        [124, 252, 0, 0, 80, 251],
        [108, 2, 141, 2, 80, 251],
        [7, 3, 55, 254, 80, 251],
        [61, 248, 186, 11, 64, 237, 1],
        [61, 248, 186, 11, 64, 237, 0],
        [0, 0, 1],
        [0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0],
    ],
    'ccs811 clock': [
        [129],
        [16],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [17],
        [2],
        [144],
        [144],
        [144],
        [152],
        [3, 32, 0, 100, 152, 0, 66, 58],
        [144],
        [152],
        [4, 176, 0, 250, 152, 0, 66, 13],
        [144],
        [16],
        [66, 13],
        [4, 0, 4, 0],
        [132, 123],
        [18],
        [16, 0],
        [32, 0],
        [18, 52],
        [144],
        [0, 0],
        [145],
        [2],
        [144],
        [152],
        [4, 176, 0, 250, 152, 0, 66, 13],
        [4],
        [144],
        [16],
        [0, 0],
        [3],
    ],
    'ccs811 no clock': [
        [129],
        [144],
        [152],
        [2, 138, 0, 42, 152, 0, 66, 75],
        [144],
        [2, 138, 0, 42, 144, 0, 66, 75],
        [152],
    ],
}


def write(slave, *data):
    slave.handle_event(I2C_START_SEND)
    for b in data:
        slave.handle_event((b << 8) | I2C_WRITE)
    slave.handle_event(I2C_FINISH)


def write_read(slave, data, n, qemu=True):
    """A write phase, then a read phase after a repeated START; QEMU reports
    that START as a FINISH and a START."""
    slave.handle_event(I2C_START_SEND)
    for b in data:
        slave.handle_event((b << 8) | I2C_WRITE)
    if qemu:
        slave.handle_event(I2C_FINISH)
    slave.handle_event(I2C_START_RECV)
    out = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_FINISH)
    return out


def run(name, qemu=True, clocked=True):
    """The scenario's reads, ops as the vector generator ran them: 'v' sets
    the panel, 't' the guest clock (ns), 'w' writes, 'r' writes then reads."""
    model, addr, ops = SCENARIOS[name]
    now = [0]
    slave = catalog_slave({'model': model, 'addr': addr}, now_ns=(lambda: now[0]) if clocked else None)
    reads = []
    for op in ops:
        if op[0] == 'v':
            slave.update(**op[1])
        elif op[0] == 't':
            now[0] = op[1]
        elif op[0] == 'w':
            write(slave, *op[1])
        else:
            reads.append(write_read(slave, op[1], op[2], qemu))
    return reads


def test_the_aggregator_loads_the_family():
    for name in ('adxl345', 'ina219', 'mlx90614', 'qmc5883l', 'ccs811'):
        assert name in MODELS
        assert catalog_slave({'model': name, 'addr': 0x10}) is not None


def test_every_model_answers_exactly_as_the_tab_model():
    for name in ('adxl345', 'ina219', 'mlx90614', 'qmc5883l', 'ccs811 clock'):
        for qemu in (True, False):
            assert run(name, qemu) == TS_BYTES[name], (name, qemu)


def test_ccs811_without_a_clock_answers_as_the_tab_with_none():
    for qemu in (True, False):
        assert run('ccs811 no clock', qemu, clocked=False) == TS_BYTES['ccs811 no clock']


def test_adxl345_counts_decode_with_the_library_4mg_per_lsb():
    s = catalog_slave({'model': 'adxl345', 'addr': 0x53, 'accelX': 0.5, 'accelY': -1, 'accelZ': 2})
    assert write_read(s, [0x00], 1) == [0xE5]
    write(s, 0x2D, 0x08)
    write(s, 0x31, 0x0B)  # setRange(16 g): FULL_RES
    d = write_read(s, [0x32], 6)
    s16 = [((d[i + 1] << 8 | d[i]) ^ 0x8000) - 0x8000 for i in (0, 2, 4)]
    assert [round(c * 0.004 * 9.80665, 2) for c in s16] == [4.90, -9.81, 19.61]


def test_ina219_reads_the_panel_current_and_bus_voltage():
    s = catalog_slave({'model': 'ina219', 'addr': 0x40, 'busVoltage': 12, 'current': -250})
    write(s, 0x05, 0x10, 0x00)  # Adafruit setCalibration_32V_2A: 4096, 0.1 mA per bit
    hi, lo = write_read(s, [0x04], 2)
    assert (((hi << 8 | lo) ^ 0x8000) - 0x8000) * 0.1 == -250
    hi, lo = write_read(s, [0x02], 2)
    assert ((hi << 8 | lo) >> 3) * 4 / 1000 == 12


def test_mlx90614_word_ends_with_the_smbus_pec():
    s = catalog_slave({'model': 'mlx90614', 'addr': 0x5A, 'ambientTemp': 25, 'objectTemp': 30})
    lo, hi, pec = write_read(s, [0x07], 3)
    assert pec == smbus_pec([0xB4, 0x07, 0xB5, lo, hi])
    assert abs((hi << 8 | lo) * 0.02 - 273.15 - 30) <= 0.02


def test_qmc5883l_heading_truncates_back_as_the_library_prints_it():
    for lsb in (3000, 12000):
        for h in range(360):
            x, y, _ = Qmc5883l.field_for(h, lsb)
            assert math.trunc(math.degrees(math.atan2(y, x))) == (h if h <= 180 else h - 360)


def ccs811_status(s):
    return write_read(s, [0x00], 1)[0]


def test_ccs811_selecting_a_mailbox_through_a_qemu_finish_is_no_write():
    """Adafruit_CCS811::begin() over QEMU: every register read is a mailbox
    write, a FINISH and a read; none of them may count as an invalid write."""
    s = catalog_slave({'model': 'ccs811', 'addr': 0x5A}, now_ns=lambda: 0)
    write(s, 0xFF, 0x11, 0xE5, 0x72, 0x8A)
    assert write_read(s, [0x20], 1) == [0x81]
    write(s, 0xF4)  # APP_START: a bare mailbox write, then a STOP
    assert ccs811_status(s) == 0x90  # FW_MODE | APP_VALID, no ERROR
    write(s, 0x01, 0x10)
    assert write_read(s, [0xE0], 1) == [0x00]
    # A bare write of a mailbox it has not is still an invalid write.
    write(s, 0x07)
    assert ccs811_status(s) == 0x91
    assert write_read(s, [0xE0], 1) == [0x01]


def test_ccs811_has_a_sample_each_drive_period_on_the_guest_clock():
    now = [5_000_000_000]
    s = catalog_slave({'model': 'ccs811', 'addr': 0x5A, 'eco2': 800, 'tvoc': 100}, now_ns=lambda: now[0])
    write(s, 0xF4)
    write(s, 0x01, 0x10)  # drive mode 1: a sample a second
    assert ccs811_status(s) == 0x90
    now[0] += 999_999_999
    assert ccs811_status(s) == 0x90
    now[0] += 1
    assert ccs811_status(s) == 0x98
    assert write_read(s, [0x02], 8)[:4] == [800 >> 8, 800 & 0xFF, 0, 100]
    assert ccs811_status(s) == 0x90
    s.update(eco2=1200, tvoc=250)
    now[0] += 1_000_000_000
    assert ccs811_status(s) == 0x98
    assert write_read(s, [0x02], 8)[:4] == [1200 >> 8, 1200 & 0xFF, 0, 250]


def test_ccs811_without_a_clock_has_one_sample_per_mode_set():
    s = catalog_slave({'model': 'ccs811', 'addr': 0x5A, 'eco2': 650, 'tvoc': 42}, now_ns=None)
    write(s, 0xF4)
    write(s, 0x01, 0x10)
    assert ccs811_status(s) == 0x98
    assert write_read(s, [0x02], 4) == [650 >> 8, 650 & 0xFF, 0, 42]
    assert ccs811_status(s) == 0x90
