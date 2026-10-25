"""The register-map chip on the ESP32 worker (app/services/catalog_regmap.py)
against the cases the tab's engine answers too
(frontend/src/__tests__/fixtures/regmap-vectors.json), and its two ways in:
an I2C catalog-i2c record and an SPI bus-map entry."""

import json
import pathlib

from app.services.catalog_i2c_models import I2C_FINISH, I2C_READ, I2C_START_RECV, I2C_START_SEND, I2C_WRITE, catalog_slave
from app.services.catalog_regmap import RegmapChip, regmap_bytes
from app.services.catalog_spi_models import catalog_spi_runtime


def _vectors() -> dict:
    here = pathlib.Path(__file__).resolve()
    for p in (here.parents[2] / 'frontend/src/__tests__/fixtures/regmap-vectors.json', here.parent / 'regmap-vectors.json'):
        if p.exists():
            return json.loads(p.read_text())
    raise FileNotFoundError('regmap-vectors.json')


VECTORS = _vectors()


def test_reading_bytes_match_the_tab():
    for c in VECTORS['bytes']:
        assert regmap_bytes(c['value'], c['v']) == c['expect'], c


def test_chips_answer_as_the_tab():
    for c in VECTORS['chips']:
        chip = RegmapChip(c['spec'])
        chip.values = dict(c['values'])
        for op in c['ops']:
            if 'set' in op:
                chip.values.update(op['set'])
            if 'w' in op:
                chip.start(False)
                for b in op['w']:
                    chip.write_byte(b)
                chip.stop()
            if 'r' in op:
                chip.start(True)
                got = [chip.read_byte() for _ in range(op['r'])]
                chip.stop()
                assert got == op['expect'], (c['name'], op)
            if 'wn' in op:
                for b in op['wn']:
                    chip.write_byte(b)
                chip.stop()
            if 'rn' in op:
                got = [chip.read_byte() for _ in range(op['rn'])]
                chip.stop()
                assert got == op['expect'], (c['name'], op)
            if 'spi' in op:
                chip.select()
                got = [chip.transfer(b) for b in op['spi']]
                chip.deselect()
                assert got == op['expect'], (c['name'], op)


LM75 = VECTORS['chips'][0]['spec']


def test_an_i2c_record_gets_a_regmap_slave_that_follows_the_panel():
    s = catalog_slave({'model': 'regmap', 'addr': 0x48, 'regmap': LM75, 'temperature': 25.5})
    assert s is not None

    def read_temp():
        s.handle_event(I2C_START_SEND)
        s.handle_event((0 << 8) | I2C_WRITE)
        s.handle_event(I2C_FINISH)
        s.handle_event(I2C_START_RECV)
        out = [s.handle_event(I2C_READ) for _ in range(2)]
        s.handle_event(I2C_FINISH)
        return out

    assert read_temp() == [25, 128]
    s.update(cmd='sensor_update', temperature=-10.5, regmap={'bus': 'i2c'})
    assert read_temp() == [245, 128]
    assert s.inputs() == {'temperature': -10.5}


def test_an_spi_entry_gets_a_regmap_runtime():
    spec = VECTORS['chips'][3]['spec']
    rt = catalog_spi_runtime('regmap', {'t': 300}, {'SCK': 18, 'MOSI': 23, 'MISO': 19, 'CS': 5},
                             {'kind': 'none'}, regmap=spec)
    assert rt is not None
    assert [rt.spi_transfer_byte(b) for b in (0xFA, 0, 0)] == [0, 1, 44]


def test_regmap_without_a_map_is_no_chip():
    assert catalog_slave({'model': 'regmap', 'addr': 0x48}) is None
    assert catalog_spi_runtime('regmap', {}, {}, {'kind': 'none'}) is None
