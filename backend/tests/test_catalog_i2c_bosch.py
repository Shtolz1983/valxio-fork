"""Bosch catalog chips on the ESP32 worker (app/services/catalog_i2c_bosch.py).

The byte vectors below were produced by the tab's TypeScript models
(Bmp180Model, Bme680Model in frontend/src/partsCatalog/models/bosch.ts) for
the same traffic, the tab's way: a write phase, a repeated START, a read
phase. The worker's twins must answer a guest exactly so, both when QEMU ends
the write phase with a FINISH before the repeated START (as it does) and when
it does not.
"""

from app.services.catalog_i2c_bosch import (
    bme680_humidity,
    bme680_pressure,
    bme680_temperature,
    bmp180_pressure,
    bmp180_tenths,
)
from app.services.catalog_i2c_models import (
    MODELS,
    I2C_FINISH,
    I2C_READ,
    I2C_START_RECV,
    I2C_START_SEND,
    I2C_WRITE,
    catalog_slave,
)

SCENARIOS = {
    'bmp180': ('bmp180', 0x77, [
        ('v', {'temperature': 24, 'pressure': 1013.25}),
        ('r', [0xD0], 1),
        ('r', [0xAA], 22),
        ('r', [0xF6], 3),
        ('w', [0xF4, 0x2E]),
        ('r', [0xF6], 2),
        ('w', [0xF4, 0x34]),
        ('r', [0xF6], 3),
        ('w', [0xF4, 0x74]),
        ('r', [0xF6], 3),
        ('w', [0xF4, 0xB4]),
        ('r', [0xF6], 3),
        ('w', [0xF4, 0xF4]),
        ('r', [0xF6], 3),
        ('r', [0xF4], 1),
        ('v', {'temperature': -40, 'pressure': 300}),
        ('w', [0xF4, 0x2E]),
        ('r', [0xF6], 2),
        ('w', [0xF4, 0x34]),
        ('r', [0xF6], 3),
        ('w', [0xF4, 0xF4]),
        ('r', [0xF6], 3),
        ('v', {'temperature': 85, 'pressure': 1100}),
        ('w', [0xF4, 0x2E]),
        ('r', [0xF6], 2),
        ('w', [0xF4, 0xB4]),
        ('r', [0xF6], 3),
        ('v', {'temperature': 12.3, 'pressure': 950.55}),
        ('w', [0xF4, 0x2E]),
        ('r', [0xF6], 2),
        ('w', [0xF4, 0x74]),
        ('r', [0xF6], 3),
        ('w', [0xE0, 0xB6]),
        ('r', [0xF4], 5),
    ]),
    'bme680': ('bme680', 0x77, [
        ('v', {'temperature': 24, 'humidity': 50, 'pressure': 1013.25, 'gas': 50}),
        ('r', [0xD0], 1),
        ('r', [0xF0], 1),
        ('r', [0x8A], 23),
        ('r', [0xE1], 14),
        ('r', [0x00], 5),
        ('r', [0x1D], 17),
        ('w', [0x72, 0x02, 0x74, 0x8C]),
        ('w', [0x5A, 0x73, 0x64, 0x59, 0x71, 0x10, 0x70, 0x00]),
        ('w', [0x74, 0x8D]),
        ('r', [0x1D], 17),
        ('r', [0x74], 1),
        ('v', {'temperature': -40, 'humidity': 0, 'pressure': 300, 'gas': 1}),
        ('w', [0x74, 0x8D]),
        ('r', [0x1D], 17),
        ('v', {'temperature': 85, 'humidity': 100, 'pressure': 1100, 'gas': 500}),
        ('w', [0x70, 0x08]),
        ('w', [0x74, 0x8D]),
        ('r', [0x1D], 17),
        ('v', {'temperature': 21.7, 'humidity': 37.3, 'pressure': 987.6, 'gas': 123.4}),
        ('w', [0x71, 0x00, 0x72, 0x00]),
        ('w', [0x74, 0x21]),
        ('r', [0x1D], 17),
        ('w', [0x72, 0x05, 0x71, 0x10, 0x70, 0x00]),
        ('w', [0x74, 0xB5]),
        ('r', [0x1D], 17),
        ('r', [0x50], 38),
        ('w', [0xE0, 0xB6]),
        ('r', [0x1D], 17),
        ('r', [0x70], 6),
    ]),
}

TS_BYTES = {
    'bmp180': [
        [85],
        [1, 152, 255, 184, 199, 209, 127, 229, 127, 245, 90, 113, 24, 46, 0, 4, 128, 0, 221, 249, 11, 52],
        [128, 0, 0],
        [113, 100],
        [131, 128, 0],
        [131, 129, 0],
        [131, 128, 192],
        [131, 128, 160],
        [212],
        [90, 55],
        [46, 90, 0],
        [46, 89, 192],
        [147, 138],
        [126, 49, 64],
        [107, 174],
        [126, 175, 128],
        [0, 0, 128, 0, 0],
    ],
    'bme680': [
        [97],
        [0],
        [58, 102, 3, 0, 78, 141, 161, 215, 88, 0, 254, 27, 112, 255, 41, 30, 0, 0, 201, 243, 216, 245, 30],
        [62, 246, 49, 0, 45, 20, 120, 156, 185, 101, 32, 209, 226, 18],
        [41, 0, 16, 0, 0],
        [0, 0, 128, 0, 0, 128, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0],
        [128, 1, 84, 93, 112, 120, 128, 128, 87, 55, 0, 0, 0, 214, 183, 214, 183],
        [140],
        [128, 2, 180, 92, 144, 70, 105, 160, 49, 96, 0, 0, 0, 120, 125, 120, 125],
        [128, 3, 86, 58, 96, 168, 53, 192, 108, 63, 0, 0, 0, 127, 228, 127, 228],
        [128, 4, 128, 0, 0, 118, 179, 208, 128, 0, 0, 0, 0, 0, 0, 0, 0],
        [128, 5, 87, 116, 128, 118, 179, 208, 79, 13, 0, 0, 0, 132, 118, 132, 118],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 115, 0, 0, 0, 0, 0, 0, 0, 0, 0, 89, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 5, 0,
         180, 0],
        [0, 0, 128, 0, 0, 128, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
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
    for name in ('bmp180', 'bme680'):
        assert name in MODELS
        assert catalog_slave({'model': name, 'addr': 0x77}) is not None


def test_every_model_answers_exactly_as_the_tab_model():
    for name in ('bmp180', 'bme680'):
        for qemu in (True, False):
            assert run(name, qemu) == TS_BYTES[name], (name, qemu)


def test_bmp180_words_decode_to_the_panel_with_the_library_arithmetic():
    s = catalog_slave({'model': 'bmp180', 'addr': 0x77, 'temperature': 21.4, 'pressure': 1002.37})
    assert write_read(s, [0xD0], 1) == [0x55]
    write(s, 0xF4, 0x2E)
    hi, lo = write_read(s, [0xF6], 2)
    ut = hi << 8 | lo
    assert bmp180_tenths(ut) == 214
    for oss in range(4):
        write(s, 0xF4, 0x34 + (oss << 6))
        b = write_read(s, [0xF6], 3)
        up = (b[0] << 16 | b[1] << 8 | b[2]) >> (8 - oss)
        assert abs(bmp180_pressure(up, ut, oss) - 100237) <= 1 + 2 ** (3 - oss)


def test_bme680_forced_measurement_decodes_to_the_panel():
    s = catalog_slave({'model': 'bme680', 'addr': 0x77, 'temperature': 21.7, 'humidity': 37.3,
                       'pressure': 987.6, 'gas': 123.4})
    assert write_read(s, [0xD0], 1) == [0x61]
    assert write_read(s, [0x1D], 1) == [0x00]  # no new data before a measurement
    write(s, 0x72, 0x05, 0x71, 0x10, 0x70, 0x00)
    write(s, 0x74, 0xB5)  # osrs_t x16, osrs_p x16, forced
    assert write_read(s, [0x74], 1) == [0xB4]  # back to sleep
    f = write_read(s, [0x1D], 17)
    assert f[0] == 0x80 and f[1] == 1
    adc_p = f[2] << 12 | f[3] << 4 | f[4] >> 4
    adc_t = f[5] << 12 | f[6] << 4 | f[7] >> 4
    adc_h = f[8] << 8 | f[9]
    t, t_fine = bme680_temperature(adc_t)
    assert abs(t - 21.7) < 0.01
    assert abs(bme680_pressure(adc_p, t_fine) - 98760) < 1
    assert abs(bme680_humidity(adc_h, t_fine) - 37.3) < 0.01
    assert f[14] & 0x30 == 0x30  # gas_valid, heat_stab
