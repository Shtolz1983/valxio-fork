"""
test_board_buses_catalog_spi_worker.py: parts-catalog SPI chips hosted in the
ESP32 QEMU worker (app/services/catalog_spi_models.py).

A catalogue module's chip travels in the tab's bus map like a portable model,
but names its Python twin (`model.catalog`) instead of shipping an artifact.
Same rig as test_board_buses_repro_worker.py: the real worker process, libqemu
stubbed at ctypes, the test playing the guest.

Pinned here:

  - a hardware-SPI chip (MAX31865, CS on a GPIO) answers the guest's bytes;
  - a bit-banged chip (MAX6675: SCK, CS and SO on plain GPIOs, as the
    Adafruit library drives them) puts each bit on SO inside the clock edge's
    pin callback, so the guest's next digitalRead sees it;
  - a panel change (`bus_attrs`) reaches the next read, and a republished map
    keeps the same instance;
  - the tab's late set_pin on the SO pad is ignored while the chip owns it.
"""
from __future__ import annotations

from .test_board_buses_repro_worker import (  # noqa: F401  (worker fixture)
    MISO,
    MOSI,
    SCK,
    Worker,
    worker,
)

TC_SCK, TC_CS, TC_SO = 25, 27, 26
RTD_CS = 5


def max6675_entry(temperature: float) -> dict:
    return {
        'owner': 'max6675-1',
        'bus_id': None,
        'cs': {'kind': 'pin', 'gpio': TC_CS, 'active_low': True},
        'model': {
            'wasm_b64': '',
            'catalog': 'max6675',
            'pin_map': {'SCK': TC_SCK, 'MISO': TC_SO, 'CS': TC_CS},
            'attrs': {'temperature': temperature},
            'blobs': {},
            'blob_ids': {},
        },
    }


def max31865_entry(temperature: float) -> dict:
    return {
        'owner': 'max31865-1',
        'bus_id': None,
        'cs': {'kind': 'pin', 'gpio': RTD_CS, 'active_low': True},
        'model': {
            'wasm_b64': '',
            'catalog': 'max31865',
            'pin_map': {'SCK': SCK, 'MOSI': MOSI, 'MISO': MISO, 'CS': RTD_CS},
            'attrs': {'temperature': temperature},
            'blobs': {},
            'blob_ids': {},
        },
    }


def so_level(w: Worker) -> int:
    """The last level the worker put on the SO pad (slot = gpio + 1)."""
    calls = w.guest('calls')['calls']
    sets = [c[2] for c in calls if c[0] == 'set_pin' and c[1] == TC_SO + 1]
    return sets[-1] if sets else 0


def read_celsius(w: Worker) -> float:
    """MAX6675::readCelsius(): CS low, 16 x (SCK low, read SO, SCK high), CS high."""
    w.pin(TC_CS, 0)
    v = 0
    for _ in range(16):
        w.pin(TC_SCK, 0)
        v = (v << 1) | so_level(w)
        w.pin(TC_SCK, 1)
    w.pin(TC_CS, 1)
    assert not v & 0x4
    return (v >> 3) * 0.25


def rtd_celsius(w: Worker) -> float:
    from app.services.catalog_spi_models import max31865_library_celsius
    w.pin(RTD_CS, 1)
    w.pin(RTD_CS, 0)
    w.spi([0x80, 0xA0])  # bias on, 1-shot
    w.pin(RTD_CS, 1)
    w.pin(RTD_CS, 0)
    _, hi, lo = w.spi([0x01, 0xFF, 0xFF])
    w.pin(RTD_CS, 1)
    return max31865_library_celsius(((hi << 8) | lo) >> 1)


class TestCatalogSpiWorker:

    def test_bit_banged_max6675_reads_the_panel_then_the_update(self, worker):
        w = worker(bus_map={'spi': [max6675_entry(25)]})
        w.pin(TC_CS, 1)
        assert read_celsius(w) == 25.0
        w.send({'cmd': 'bus_attrs', 'owner': 'max6675-1', 'attrs': {'temperature': 432.75}})
        w.sync()
        assert read_celsius(w) == 432.75

    def test_a_republished_map_keeps_the_chip_and_takes_its_values(self, worker):
        w = worker(bus_map={'spi': [max6675_entry(25)]})
        w.pin(TC_CS, 1)
        assert read_celsius(w) == 25.0
        w.send({'cmd': 'bus_map', 'spi': [max6675_entry(100.5)]})
        w.sync()
        assert read_celsius(w) == 100.5

    def test_the_tabs_late_set_pin_on_so_is_ignored(self, worker):
        w = worker(bus_map={'spi': [max6675_entry(25)]})
        w.pin(TC_CS, 1)
        before = len([c for c in w.guest('calls')['calls'] if c[0] == 'set_pin'])
        w.send({'cmd': 'set_pin', 'pin': TC_SO, 'value': 1})
        w.sync()
        calls = w.guest('calls')['calls'][before:]
        assert not [c for c in calls if c[0] == 'set_pin' and c[1] == TC_SO + 1]
        assert read_celsius(w) == 25.0

    def test_hardware_spi_max31865_answers_and_follows_the_panel(self, worker):
        w = worker(bus_map={'spi': [max31865_entry(-78.5)]})
        assert abs(rtd_celsius(w) + 78.5) < 0.05
        w.send({'cmd': 'bus_attrs', 'owner': 'max31865-1', 'attrs': {'temperature': 600}})
        w.sync()
        assert abs(rtd_celsius(w) - 600) < 0.05
