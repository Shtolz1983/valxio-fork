"""
test_board_buses_f7_worker_chip.py: the ESP32 worker hosts EVERY handle and
EVERY address a custom chip attaches (project/board-buses-2026-09, F7).

The worker runs unmodified on the repro suite's rig (libqemu replaced at the
ctypes boundary) with the cross-host fixture chip abi-probe.c
(frontend/src/__tests__/board-buses/fixtures/chips-abi-parity/): two SPI
handles behind two selects (the second answers each byte through
on_exchange), and two I2C addresses on one SDA/SCL. Before F7 the runtime
kept one SPI config and one I2C address per chip, the last attach winning,
so the worker's bus tables never saw the first handle or the first address:
the worker-side face of finding spi-done-bufptr-shared, and a chip like the
ST25DV (two addresses) answering at one of them only.

The chip's trace is not reachable through the rig (the worker calls no probe
export), so what is asserted is what the GUEST sees: the MISO of each handle
behind its own select, and the ACK and the byte at each address.
"""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

pytest.importorskip('wasmtime', reason='the custom-chip runtime needs wasmtime')

from .test_board_buses_repro_worker import (  # noqa: E402
    I2C_FINISH, I2C_READ, I2C_START_RECV, I2C_START_SEND, I2C_WRITE, MISO, MOSI, SCK, worker,  # noqa: F401
)

ABI_PROBE = (Path(__file__).resolve().parents[3] / 'frontend' / 'src' / '__tests__'
             / 'board-buses' / 'fixtures' / 'chips-abi-parity' / 'abi-probe.wasm')
CS, CS2 = 5, 17


def abi_chip() -> dict:
    return {
        'sensor_type': 'custom-chip', 'pin': 400,
        'wasm_b64': base64.b64encode(ABI_PROBE.read_bytes()).decode('ascii'),
        'attrs': {}, 'component_id': 'abi',
        'pin_map': {'CS': CS, 'CS2': CS2, 'SCK': SCK, 'MOSI': MOSI, 'MISO': MISO},
        'nets': [], 'uart_map': {},
    }


def test_setup_the_chip_loads_and_registers_both_addresses(worker):
    w = worker(sensors=[abi_chip()])
    assert 'abi probe ready' in w.chip_log()
    assert w.wait_for(lambda: any('0x42, 0x43' in t for t in w.stderr), 3.0), w.stderr[-10:]


def test_the_second_spi_handle_answers_behind_its_own_select(worker):
    """Handle 1 (CS2) answers each byte inverted through on_exchange; handle
    0 (CS) is not armed and, selected, leaves the line idle."""
    w = worker(sensors=[abi_chip()])
    w.pin(CS, 1)
    w.pin(CS2, 1)
    assert w.spi([0x0F]) == [0xFF], 'nothing selected: idle'
    w.pin(CS2, 0)
    assert w.spi([0x0F, 0xF0]) == [0xF0, 0x0F], 'the second handle, behind CS2'
    w.pin(CS2, 1)
    w.pin(CS, 0)
    assert w.spi([0x0F]) == [0xFF], 'the first handle, selected but not armed, drives nothing'
    w.pin(CS, 1)


def test_both_i2c_addresses_ack_and_serve_their_own_bytes(worker):
    """0x42 serves 0x30 + its pointer, 0x43 serves 0x40 + its own."""
    w = worker(sensors=[abi_chip()])
    assert w.i2c(0, 0x42, [I2C_START_SEND, I2C_WRITE | (0x05 << 8), I2C_FINISH]) == [0, 0, 0]
    assert w.i2c(0, 0x42, [I2C_START_RECV, I2C_READ, I2C_FINISH])[:2] == [0, 0x35]
    assert w.i2c(0, 0x43, [I2C_START_SEND, I2C_WRITE | (0x02 << 8), I2C_FINISH]) == [0, 0, 0]
    assert w.i2c(0, 0x43, [I2C_START_RECV, I2C_READ, I2C_FINISH])[:2] == [0, 0x42]
    assert w.i2c(0, 0x44, [I2C_START_SEND, I2C_FINISH])[0] != 0, 'an address the chip did not attach'
