"""
test_board_buses_f6_worker_uart.py: the QEMU workers' UART chips on the guest
UART their wiring puts them on (project/board-buses-2026-09, F6-SPEC
"Motores", findings grove-worker-no-uart-map and
esp32-variant-uart-table-wrong).

Two layers, as test_board_buses_f5_worker_i2c.py has them:

  - the table itself (app/services/uart_bus_table.py), driven directly: plain
    Python, shared by the ESP32 and the STM32 workers, and it holds every rule
    this file is about;
  - the ESP32 worker running unmodified on the repro suite's rig (libqemu
    replaced at the ctypes boundary, the guest played by calling the worker's
    own callbacks), for the parts only the worker has: the map arriving in the
    start config and as a command, the chip's reply going into the UART the
    map names, and the GPIO matrix telling which UART a pad carries.

The rules, as the tab's fabric has them (simulation/buses/uartBus.ts):

  - a chip hears the controller whose TX its RX leg is wired to, and only
    that one; its replies land in the same controller;
  - it is registered and removed by identity;
  - the live matrix wins over the tab's static answer when it names a UART on
    the pad; a pad the matrix does not route falls back to the tab's answer
    (ESP-IDF 5 puts a port on its IO_MUX pins without the matrix);
  - an owner the map lists as unplaced, or places on no controller, is
    silent both ways, and so is a record the map says nothing about: the
    record's own word (the pre-F6 uart_map, Serial1 when it had none) is
    not asked (F6 second part; before it, that word was the fallback).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SERVICES = HERE.parent.parent.parent / 'backend' / 'app' / 'services'

_spec = importlib.util.spec_from_file_location('uart_bus_table_under_test',
                                               SERVICES / 'uart_bus_table.py')
table_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
sys.modules['uart_bus_table_under_test'] = table_mod
_spec.loader.exec_module(table_mod)  # type: ignore[union-attr]
UartBusTable = table_mod.UartBusTable
NOT_ROUTED = table_mod.NOT_ROUTED
owner_of = table_mod.owner_of


class Chip:
    """A stand-in runtime: what the table dispatches to."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.heard: list[int] = []

    def feed_uart_byte(self, b: int) -> None:
        self.heard.append(b)


def entry(owner: str, rx_uart=None, tx_uart=None, rx_pin=None, tx_pin=None) -> dict:
    return {'owner': owner, 'rx_uart': rx_uart, 'tx_uart': tx_uart,
            'rx_pin': rx_pin, 'tx_pin': tx_pin, 'baud': 9600, 'frame': '8N1'}


# ── The table ────────────────────────────────────────────────────────────────


class TestTableRegistration:
    def test_a_record_nobody_placed_is_silent(self):
        """Before any map, and for an owner the map never names: on no unit.
        The record's own word (its pre-F6 uart_map, Serial1 when it had
        none) is not asked; a wire the tab has not mapped leads nowhere."""
        t = UartBusTable()
        a, b = Chip('a'), Chip('b')
        t.add(a, a, owner='chipA')
        t.add(b, b, owner='chipB')
        assert t.unit_of(a) is None
        assert t.unit_of(b) is None
        assert t.runtimes_on(2) == []
        assert t.runtimes_on(1) == []
        assert t.runtimes_on(0) == []

    def test_removal_is_by_identity(self):
        t = UartBusTable()
        a, b = Chip('a'), Chip('b')
        t.add(a, a, owner='chipA')
        t.add(b, b, owner='chipB')
        t.apply_map([entry('chipA', rx_uart=1), entry('chipB', rx_uart=1)])
        assert t.remove(a) is a
        assert t.remove(a) is None
        assert t.runtimes_on(1) == [b]
        assert a not in t and b in t

    def test_the_same_key_again_replaces(self):
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.add(a, a, owner='chipB')
        t.apply_map([entry('chipA', rx_uart=1), entry('chipB', rx_uart=2)])
        assert len(t) == 1
        assert t.unit_of(a) == 2

    def test_an_unknown_key_answers_the_default(self):
        t = UartBusTable()
        assert t.unit_of(object(), default=1) == 1
        assert t.unit_of(object()) is None

    def test_owner_of_prefers_the_fabric_owner_over_the_component_id(self):
        assert owner_of({'owner': 'm1', 'component_id': 'c1'}) == 'm1'
        assert owner_of({'component_id': 'c1'}) == 'c1'
        assert owner_of({'owner': '', 'component_id': ''}) is None
        assert owner_of({}) is None


class TestTableMap:
    def test_the_map_places_an_owner_on_the_controller_that_feeds_its_rx(self):
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2, tx_uart=2, rx_pin=17, tx_pin=16)])
        assert t.unit_of(a) == 2
        assert t.runtimes_on(2) == [a]
        assert t.runtimes_on(1) == []

    def test_a_tx_only_leg_names_the_controller_that_reads_it(self):
        """A GPS: no RX leg, its TX on the board's RX pin."""
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='gps')
        t.apply_map([entry('gps', tx_uart=2, tx_pin=16)])
        assert t.unit_of(a) == 2

    def test_an_endpoint_on_no_controller_is_silent(self):
        """Both legs on plain GPIOs (or unwired): nobody drives its RX and
        nobody reads its TX. No Serial1 fallback: a wire leads nowhere."""
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_pin=32, tx_pin=33)])
        assert t.unit_of(a) is None
        assert t.runtimes_on(1) == []

    def test_an_unplaced_owner_is_silent(self):
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([{'unplaced': ['chipA']}])
        assert t.unit_of(a) is None
        assert t.runtimes_on(1) == []

    def test_an_owner_absent_from_the_next_map_is_silent(self):
        """The whole list travels every time: an owner that left the tab's
        fabric is gone by being absent, and on no unit."""
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2)])
        t.apply_map([])
        assert t.unit_of(a) is None
        assert t.runtimes_on(2) == []

    def test_a_map_with_no_uart_key_keeps_the_placement(self):
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2)])
        t.apply_map(None)
        assert t.unit_of(a) == 2

    def test_the_map_is_read_again_per_byte_when_it_arrives_after_the_chip(self):
        """Registration and map in either order: the answer is the same."""
        t = UartBusTable()
        t.apply_map([entry('chipA', rx_uart=2)])
        a = Chip('a')
        t.add(a, a, owner='chipA')
        assert t.unit_of(a) == 2

    def test_garbage_entries_are_ignored(self):
        t = UartBusTable()
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([None, 42, {'owner': ''}, {'unplaced': 'chipA'},
                     entry('chipA', rx_uart='2', tx_uart=True)])
        # '2' is taken as a unit, True (a bool) is not.
        assert t.unit_of(a) == 2
        assert t.placement_of('chipA') == {'rx_uart': 2, 'tx_uart': None, 'rx_pin': None,
                                           'tx_pin': None, 'silent': False}

    def test_runtimes_on_a_controller_are_in_owner_order(self):
        t = UartBusTable()
        b, a = Chip('b'), Chip('a')
        t.add(b, b, owner='zeta')
        t.add(a, a, owner='alpha')
        t.apply_map([entry('zeta', rx_uart=1), entry('alpha', rx_uart=1)])
        assert t.runtimes_on(1) == [a, b]


class TestTableMatrix:
    def test_the_live_matrix_wins_over_the_tabs_static_answer(self):
        routed = {17: 1}
        t = UartBusTable(resolve_tx_pad=lambda pad: routed.get(pad, NOT_ROUTED))
        a = Chip('a')
        t.add(a, a, owner='chipA')
        # The tab's static table puts pad 17 on UART2 (U2TXD IO_MUX); the
        # sketch did Serial1.begin(9600, SERIAL_8N1, 16, 17).
        t.apply_map([entry('chipA', rx_uart=2, tx_uart=2, rx_pin=17, tx_pin=16)])
        assert t.unit_of(a) == 1
        routed[17] = 2
        assert t.unit_of(a) == 2

    def test_a_pad_the_matrix_does_not_route_falls_back_to_the_tab(self):
        """ESP-IDF 5 puts UART0/UART2 on their IO_MUX pins without touching the
        matrix, so an unrouted pad is not "no UART": the tab's table decides."""
        t = UartBusTable(resolve_tx_pad=lambda pad: NOT_ROUTED)
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2, tx_uart=2, rx_pin=17, tx_pin=16)])
        assert t.unit_of(a) == 2

    def test_a_matrix_that_cannot_be_read_falls_back_to_the_tab(self):
        t = UartBusTable(resolve_tx_pad=lambda pad: None)
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2, rx_pin=17)])
        assert t.unit_of(a) == 2

    def test_a_pad_no_one_can_name_leaves_the_chip_silent(self):
        t = UartBusTable(resolve_tx_pad=lambda pad: NOT_ROUTED)
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_pin=32, tx_pin=33)])
        assert t.unit_of(a) is None

    def test_only_the_rx_leg_pad_is_asked_of_the_matrix(self):
        """The TX leg lands on the board's RX pad, whose input select the
        worker cannot read; asking the matrix about it would read the OUTPUT
        signal of some other peripheral on that pad."""
        asked: list[int] = []

        def resolve(pad: int):
            asked.append(pad)
            return NOT_ROUTED
        t = UartBusTable(resolve_tx_pad=resolve)
        a = Chip('a')
        t.add(a, a, owner='chipA')
        t.apply_map([entry('chipA', rx_uart=2, tx_uart=2, rx_pin=17, tx_pin=16)])
        t.unit_of(a)
        assert asked == [17]


# ── The ESP32 worker ─────────────────────────────────────────────────────────

try:
    from .test_board_buses_repro_worker import (  # noqa: E402,F401  (worker fixture)
        _wasm,
        worker,
    )
except pytest.skip.Exception as _no_rig:
    _RIG_MISSING = str(_no_rig)

    @pytest.fixture
    def worker():
        pytest.skip(_RIG_MISSING)

# Classic ESP32: U2TXD / U2RXD IO_MUX pads, and the GPIO matrix signals that
# put UART1 or UART2 on a pad (gpio_sig_map.h U1TXD_OUT_IDX, U2TXD_OUT_IDX).
U2_TX_PAD, U2_RX_PAD = 17, 16
U1TXD_OUT, U2TXD_OUT = 17, 198
GPIO_OUT = 256


def uart_chip(pin: int, chip_id: int, owner: str, uart_map: dict | None = None) -> dict:
    """The record a Grove UART module sends the worker: no uart_map (the
    fabric's map places it), unless a test sends the pre-F6 shape to show
    that it is ignored."""
    return {
        'sensor_type': 'custom-chip', 'pin': pin, 'wasm_b64': _wasm('uart-probe'),
        'attrs': {'id': chip_id}, 'component_id': owner,
        'pin_map': {'RX': U2_TX_PAD, 'TX': U2_RX_PAD}, 'nets': [],
        'uart_map': uart_map or {},
    }


def say(w, uart: int, byte: int) -> None:
    """The guest transmits one byte on `uart`."""
    w.guest('uart', uart=uart, byte=byte)


def replies(w) -> list[tuple[int, list[int]]]:
    """Every chip reply the worker injected into a guest UART: (uart, bytes)."""
    return [(c[1], c[2]) for c in w.guest('calls')['calls'] if c[0] == 'uart_receive']


class TestWorkerUnmapped:
    def test_setup_a_record_with_its_own_uart_map_is_silent_until_the_tab_maps_it(self, worker):
        """The pre-F6 shape: a record carrying the {gpio: uart} table the tab
        used to guess. It is not honoured: with no map from the fabric the
        chip hears no UART, the one its table named included."""
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA', {U2_TX_PAD: 2, U2_RX_PAD: 2})])
        say(w, 2, 0x41)
        say(w, 1, 0x42)
        say(w, 0, 0x43)
        assert replies(w) == []

    def test_setup_a_record_with_nothing_is_silent_on_serial1_too(self, worker):
        """Where every chip used to land unconditionally (Serial1) is no
        longer a place a record lands."""
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')])
        say(w, 1, 0x41)
        say(w, 0, 0x42)
        assert replies(w) == []


class TestWorkerMap:
    def test_the_start_config_map_puts_a_grove_record_on_uart2(self, worker):
        """grove-worker-no-uart-map: the module sends no uart_map; the fabric's
        map, from the wiring, puts it on the UART it is wired to."""
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')],
                   bus_map={'spi': [], 'uart': [{'owner': 'chipA', 'rx_uart': 2, 'tx_uart': 2,
                                                 'rx_pin': U2_TX_PAD, 'tx_pin': U2_RX_PAD,
                                                 'baud': 9600, 'frame': '8N1'}]})
        say(w, 1, 0x41)
        say(w, 2, 0x42)
        assert replies(w) == [(2, [0x11, 0x42])]

    def test_a_map_command_moves_it_and_an_unplaced_entry_silences_it(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')])
        w.send({'cmd': 'bus_map', 'uart': [{'owner': 'chipA', 'rx_uart': 0, 'tx_uart': 0}]})
        w.sync()
        say(w, 1, 0x41)
        say(w, 0, 0x42)
        assert replies(w) == [(0, [0x11, 0x42])]
        w.send({'cmd': 'bus_map', 'uart': [{'unplaced': ['chipA']}]})
        w.sync()
        say(w, 0, 0x43)
        say(w, 1, 0x43)
        say(w, 2, 0x43)
        assert replies(w) == [(0, [0x11, 0x42])]

    def test_a_map_with_no_uart_key_leaves_the_placement(self, worker):
        """An I2C-only map (F5) sent after a UART one must not undo it."""
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')],
                   bus_map={'spi': [], 'uart': [{'owner': 'chipA', 'rx_uart': 2, 'tx_uart': 2}]})
        w.send({'cmd': 'bus_map', 'i2c': []})
        w.send({'cmd': 'bus_map', 'spi': []})
        w.sync()
        say(w, 2, 0x41)
        assert replies(w) == [(2, [0x11, 0x41])]

    def test_two_chips_on_two_uarts_each_hear_their_own(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA'), uart_chip(401, 0x22, 'chipB')],
                   bus_map={'spi': [], 'uart': [{'owner': 'chipA', 'rx_uart': 1, 'tx_uart': 1},
                                                {'owner': 'chipB', 'rx_uart': 2, 'tx_uart': 2}]})
        say(w, 1, 0x41)
        say(w, 2, 0x42)
        say(w, 0, 0x43)
        assert replies(w) == [(1, [0x11, 0x41]), (2, [0x22, 0x42])]

    def test_a_detached_chip_hears_nothing_and_the_other_stays(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA'), uart_chip(401, 0x22, 'chipB')],
                   bus_map={'spi': [], 'uart': [{'owner': 'chipA', 'rx_uart': 2, 'tx_uart': 2},
                                                {'owner': 'chipB', 'rx_uart': 2, 'tx_uart': 2}]})
        w.send({'cmd': 'sensor_detach', 'pin': 400})
        w.sync()
        say(w, 2, 0x41)
        assert replies(w) == [(2, [0x22, 0x41])]

    def test_a_chip_attached_mid_run_takes_the_map_already_there(self, worker):
        w = worker(bus_map={'spi': [], 'uart': [{'owner': 'chipA', 'rx_uart': 2, 'tx_uart': 2}]})
        w.send({'cmd': 'sensor_attach', **uart_chip(400, 0x11, 'chipA')})
        w.sync()
        say(w, 1, 0x41)
        say(w, 2, 0x42)
        assert replies(w) == [(2, [0x11, 0x42])]


class TestWorkerMatrix:
    """The tab names the UART its static table gives the pad; the sketch may
    have routed another port there through the matrix, which the worker can
    read (esp32-variant-uart-table-wrong, the live half)."""

    ENTRY = {'owner': 'chipA', 'rx_uart': 2, 'tx_uart': 2, 'rx_pin': U2_TX_PAD, 'tx_pin': U2_RX_PAD}

    def test_the_pad_routed_to_uart1_moves_the_chip_to_uart1(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')], bus_map={'spi': [], 'uart': [self.ENTRY]})
        w.guest('matrix', out_sel={str(U2_TX_PAD): U1TXD_OUT})
        say(w, 2, 0x41)
        say(w, 1, 0x42)
        assert replies(w) == [(1, [0x11, 0x42])]

    def test_the_pad_routed_back_to_uart2_moves_it_back(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')], bus_map={'spi': [], 'uart': [self.ENTRY]})
        w.guest('matrix', out_sel={str(U2_TX_PAD): U1TXD_OUT})
        say(w, 1, 0x41)
        w.guest('matrix', out_sel={str(U2_TX_PAD): U2TXD_OUT})
        say(w, 1, 0x42)
        say(w, 2, 0x43)
        assert replies(w) == [(1, [0x11, 0x41]), (2, [0x11, 0x43])]

    def test_a_pad_the_matrix_leaves_as_gpio_keeps_the_tabs_answer(self, worker):
        """IO_MUX-direct routing: the matrix says plain GPIO, the tab said UART2."""
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')], bus_map={'spi': [], 'uart': [self.ENTRY]})
        w.guest('matrix', out_sel={str(U2_TX_PAD): GPIO_OUT})
        say(w, 1, 0x41)
        say(w, 2, 0x42)
        assert replies(w) == [(2, [0x11, 0x42])]

    def test_setup_without_a_readable_matrix_the_tab_decides(self, worker):
        w = worker(sensors=[uart_chip(400, 0x11, 'chipA')], bus_map={'spi': [], 'uart': [self.ENTRY]})
        say(w, 2, 0x41)
        assert replies(w) == [(2, [0x11, 0x41])]
