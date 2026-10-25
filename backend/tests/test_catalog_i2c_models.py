"""Parts-catalog I2C chips on the ESP32 worker (app/services/catalog_i2c_models.py).

The byte vectors below were produced by the tab's TypeScript models
(frontend/src/partsCatalog/simModels.ts, models/bosch.ts) for the same traffic:
the worker's twins must answer a guest exactly as the tab answers an Uno.
"""

from app.services.catalog_i2c_models import (
    I2C_FINISH,
    I2C_READ,
    I2C_START_RECV,
    I2C_START_SEND,
    I2C_WRITE,
    catalog_slave,
    crc8,
)

TS_BYTES = {
    'bme280 24 50 1013.25': [100, 42, 144, 126, 20, 128, 113, 178],
    'bme280 -12.5 83 950.5': [101, 46, 176, 97, 193, 128, 139, 250],
    'bme280 41.3 7 1100': [91, 241, 80, 139, 149, 128, 84, 135],
    'sht31': [100, 52, 86, 156, 40, 71],
    'aht20': [24, 84, 122, 227, 0, 0, 176],
    'bh1750': [2, 88],
}


def write(slave, *data):
    slave.handle_event(I2C_START_SEND)
    for b in data:
        slave.handle_event((b << 8) | I2C_WRITE)
    slave.handle_event(I2C_FINISH)


def read(slave, n):
    slave.handle_event(I2C_START_RECV)
    out = [slave.handle_event(I2C_READ) for _ in range(n)]
    slave.handle_event(I2C_FINISH)
    return out


def test_crc8_test_vector():
    assert crc8([0xBE, 0xEF]) == 0x92


def test_bme280_answers_exactly_as_the_tab_model():
    for (t, h, p) in ((24, 50, 1013.25), (-12.5, 83, 950.5), (41.3, 7, 1100)):
        s = catalog_slave({'model': 'bme280', 'addr': 0x76, 'temperature': t, 'humidity': h, 'pressure': p})
        assert read_id(s) == 0x60
        write(s, 0xF2, 0x01)
        write(s, 0xF4, 0x25)  # osrs_t x1, osrs_p x1, forced
        write(s, 0xF7)
        assert read(s, 8) == TS_BYTES[f'bme280 {t:g} {h:g} {p:g}']


def read_id(s):
    write(s, 0xD0)
    return read(s, 1)[0]


def test_bme280_forced_measurement_reports_measuring_once():
    s = catalog_slave({'model': 'bme280', 'addr': 0x76})
    write(s, 0xF4, 0x25)
    write(s, 0xF3)
    assert read(s, 1) == [0x08]
    write(s, 0xF3)
    assert read(s, 1) == [0x00]


def test_sht31_aht20_bh1750_match_the_tab_and_decode_as_their_libraries():
    sht = catalog_slave({'model': 'sht31', 'addr': 0x44, 'temperature': 23.5, 'humidity': 61})
    write(sht, 0x24, 0x00)
    b = read(sht, 6)
    assert b == TS_BYTES['sht31']
    assert b[2] == crc8(b[0:2]) and b[5] == crc8(b[3:5])
    # Adafruit_SHT31::readTempHum's integer conversion.
    assert abs((((4375 * ((b[0] << 8) | b[1])) >> 14) - 4500) / 100 - 23.5) < 0.02

    aht = catalog_slave({'model': 'aht20', 'addr': 0x38, 'temperature': -12.5, 'humidity': 33})
    write(aht, 0xAC, 0x33, 0x00)
    assert read(aht, 7) == TS_BYTES['aht20']

    bh = catalog_slave({'model': 'bh1750', 'addr': 0x23, 'lux': 500})
    write(bh, 0x10)
    raw = read(bh, 2)
    assert raw == TS_BYTES['bh1750']
    assert abs(((raw[0] << 8) | raw[1]) / 1.2 - 500) < 1


def test_update_takes_only_panel_values():
    s = catalog_slave({'model': 'sht31', 'addr': 0x44, 'temperature': 20, 'humidity': 40})
    s.update(cmd='sensor_update', pin=300, temperature='31.5', humidity=True, owner='sht31_1')
    assert s.inputs() == {'temperature': 31.5, 'humidity': 40.0}


def test_an_unknown_model_gets_no_slave():
    assert catalog_slave({'model': 'no-such-chip', 'addr': 0x10}) is None
