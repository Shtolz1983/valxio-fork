"""Chip-to-chip net fan-out in the ESP32 custom-chip runtime.

Two layers:

  1. ChipNetBus on its own, with a stub member. Level, fan-out, the source
     exclusion, per-member edge detection, the re-entrancy guard, and the
     publish / apply path the cross-board bridge uses.

  2. The real thing: the two chip models (SX1262 and KQ-130F, by Martin Thuku) in test/fixtures/chip-nets, whose
     `ANT` and `LINE` pins are wired only to each other and so have no board
     GPIO at all. Before the bus existed, vx_pin_watch dropped those watches
     and the net carried nothing on an ESP32 board. These cases drive a whole
     Manchester frame across one and read the payload out the other end.

The models measure edge intervals, so the wasm cases run on VIRTUAL time: a
clock the test advances to the next armed timer deadline, rather than the wall
clock, whose scheduler jitter lands straight in those measurements. Same
reason and same technique as test/fixtures/chip-nets/chip_selftest.py.

Run from the repo root:
    pytest test/backend/unit/test_chip_nets.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend/ is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

# wasm_chip_runtime imports wasmtime at module scope, so the skip has to come
# before the import rather than in front of the cases that load a .wasm.
pytest.importorskip('wasmtime', reason='chip runtime needs wasmtime')

from app.services.wasm_chip_runtime import ChipNetBus, WasmChipRuntime  # noqa: E402

# The fixture compiler sits next to this file; the unit directory is a
# package, so it is reached by path rather than through pytest's rootdir.
sys.path.insert(0, str(Path(__file__).parent))
from chip_fixtures import chips_available, compiled_chip  # noqa: E402

SX_BIT_US = 20.0    # chip.json defaults, so the tests prove the shipped values
KQ_BIT_US = 200.0


# ── Layer 1: the bus on its own ──────────────────────────────────────────────


class _StubMember:
    """Stands in for a WasmChipRuntime: records what the bus fans out to it."""

    def __init__(self) -> None:
        self.seen: list[tuple[int, int]] = []
        self.stamps: list[int | None] = []

    def notify_net_change(self, handle: int, value: int, at_ns: int | None = None) -> None:
        self.seen.append((handle, value))
        self.stamps.append(at_ns)


def test_bus_drives_every_member_but_the_writer():
    bus = ChipNetBus()
    a, b, c = _StubMember(), _StubMember(), _StubMember()
    bus.register('net', a, 0)
    bus.register('net', b, 3)
    bus.register('net', c, 7)

    bus.drive('net', 1, source=(a, 0))

    assert a.seen == []                 # the writer does not hear itself
    assert b.seen == [(3, 1)]
    assert c.seen == [(7, 1)]
    assert bus.level('net') == 1


def test_bus_keeps_nets_apart():
    bus = ChipNetBus()
    a, b = _StubMember(), _StubMember()
    bus.register('ant', a, 0)
    bus.register('line', b, 0)

    bus.drive('ant', 1)

    assert b.seen == []
    assert bus.level('ant') == 1
    assert bus.level('line') == 0
    assert bus.level('nothing-wired-here') is None


def test_bus_reentrancy_guard_stops_a_write_back_loop():
    """A member that drives the same net from inside its own callback must not
    recurse. The level still lands; the second fan-out is what is skipped."""
    bus = ChipNetBus()

    class _Echo:
        def __init__(self) -> None:
            self.depth = 0
            self.max_depth = 0

        def notify_net_change(self, handle: int, value: int) -> None:
            self.depth += 1
            self.max_depth = max(self.max_depth, self.depth)
            bus.drive('net', 0 if value else 1, source=(self, handle))
            self.depth -= 1

    echo = _Echo()
    writer = _StubMember()
    bus.register('net', writer, 0)
    bus.register('net', echo, 1)

    bus.drive('net', 1, source=(writer, 0))

    assert echo.max_depth == 1
    assert bus.level('net') == 0        # the echo's write took effect


def test_bus_publishes_only_nets_marked_remote():
    published: list[tuple[str, int, int]] = []
    bus = ChipNetBus(publisher=lambda net, level, ts: published.append((net, level, ts)))
    local, remote = _StubMember(), _StubMember()
    bus.register('local-net', local, 0)
    bus.register('remote-net', remote, 0)
    bus.mark_remote(['remote-net'])

    bus.drive('local-net', 1)
    bus.drive('remote-net', 1, ts_ns=1234)

    assert bus.is_remote('remote-net') and not bus.is_remote('local-net')
    assert published == [('remote-net', 1, 1234)]


def test_bus_unregister_drops_a_detached_member():
    bus = ChipNetBus()
    a, b, c = _StubMember(), _StubMember(), _StubMember()
    bus.register('n', a, 0)
    bus.register('n', b, 0)
    bus.register('n', c, 0)
    bus.unregister(b)
    bus.drive('n', 1, source=(a, 0))
    assert b.seen == []
    assert c.seen == [(0, 1)]
    # The net keeps its level for whoever asks.
    assert bus.level('n') == 1


def test_bus_never_republishes_what_a_peer_drove():
    """Otherwise two bridged workers would echo one edge back and forth."""
    published: list[tuple[str, int, int]] = []
    bus = ChipNetBus(publisher=lambda net, level, ts: published.append((net, level, ts)))
    member = _StubMember()
    bus.register('net', member, 2)
    bus.mark_remote(['net'])

    bus.apply_remote('net', 1, ts_ns=99)

    assert published == []
    assert member.seen == [(2, 1)]      # but the local members do see it
    assert bus.level('net') == 1


# ── Layer 2: the chip models ─────────────────────────────────────────────────

pytestmark_wasm = pytest.mark.skipif(
    not chips_available(),
    reason='wasi-sdk not available to compile the chip fixtures',
)


@pytest.fixture()
def virtual_clock(monkeypatch):
    """Redirect sim_now_nanos to a clock the test advances by hand."""
    now = [0]
    monkeypatch.setattr(WasmChipRuntime, 'sim_now_nanos', lambda _self: now[0])
    return now


def _pump(now, runtimes, max_events: int = 4_000_000, stop=None) -> bool:
    """Advance virtual time to the next armed deadline and fire it, until
    `stop()` holds or nothing is armed any more."""
    for _ in range(max_events):
        if stop is not None and stop():
            return True
        deadlines = [d for d in (rt.next_timer_deadline() for rt in runtimes)
                     if d is not None]
        if not deadlines:
            break
        now[0] = max(now[0], min(deadlines))
        for rt in runtimes:
            rt.fire_due_timers()
    return stop() is True if stop is not None else True


class _Plc:
    """One KQ-130F. TX / RX have board GPIOs; LINE has none and lives on the
    net, which is exactly the wiring that used to carry nothing."""

    def __init__(self, bus, net_id, label, base_gpio, attrs=None):
        self.out = bytearray()
        self.logs: list[str] = []
        values = {'line_noise_percent': 0.0, 'bit_period_us': KQ_BIT_US,
                  'label': label}
        values.update(attrs or {})
        self.rt = WasmChipRuntime(
            compiled_chip('kq130f'),
            values,
            self._emit,
            pin_map={'TX': base_gpio, 'RX': base_gpio + 1},
            uart_writer=lambda data: self.out.extend(data),
            net_map={'LINE': net_id} if net_id is not None else None,
            net_bus=bus,
        )
        self.rt.run_chip_setup()

    def _emit(self, payload: dict) -> None:
        if payload.get('type') in ('chip_log', 'chip_warning', 'chip_error'):
            self.logs.append(str(payload.get('text') or payload.get('error') or payload))

    def host_send(self, data: bytes) -> None:
        for byte in data:
            self.rt.feed_uart_byte(byte)


@pytestmark_wasm
def test_line_net_carries_bytes_between_two_chips(virtual_clock):
    """The headline case: a pin with no GPIO at either end still conducts."""
    bus = ChipNetBus()
    a = _Plc(bus, 'mains', 'plcA', 10)
    b = _Plc(bus, 'mains', 'plcB', 30)

    msg = b'xkoin plc 1\n'
    a.host_send(msg)
    _pump(virtual_clock, [a.rt, b.rt], stop=lambda: bytes(b.out) == msg)

    assert bytes(b.out) == msg
    assert bytes(a.out) == b''          # a module never hears its own burst


@pytestmark_wasm
def test_without_a_net_the_line_carries_nothing(virtual_clock):
    """The behaviour this patch changes, pinned so the fan-out cannot be
    quietly reduced to a no-op: with no net_map the LINE pin has neither a
    GPIO nor a net, vx_pin_watch has nothing to watch, and the burst one chip
    transmits is never seen by the other."""
    a = _Plc(None, None, 'plcA', 10)
    b = _Plc(None, None, 'plcB', 30)

    a.host_send(b'xkoin plc 0\n')
    _pump(virtual_clock, [a.rt, b.rt])

    assert bytes(b.out) == b''
    assert not a.rt.has_net_watches() and not b.rt.has_net_watches()


@pytestmark_wasm
def test_line_net_does_not_reach_a_chip_on_another_net(virtual_clock):
    bus = ChipNetBus()
    a = _Plc(bus, 'mains', 'plcA', 10)
    b = _Plc(bus, 'mains', 'plcB', 30)
    elsewhere = _Plc(bus, 'other-mains', 'plcC', 50)

    msg = b'xkoin plc 2\n'
    a.host_send(msg)
    _pump(virtual_clock, [a.rt, b.rt, elsewhere.rt], stop=lambda: bytes(b.out) == msg)

    assert bytes(b.out) == msg
    assert bytes(elsewhere.out) == b''


@pytestmark_wasm
def test_chip_net_bridges_two_buses(virtual_clock):
    """Cross-board: two buses stand in for two QEMU workers, joined only by
    the publish / apply hop the frontend interconnect performs. Each bus holds
    one chip, so nothing arrives except through the bridge."""
    hops = [0]

    bus_a: ChipNetBus
    bus_b: ChipNetBus

    def to_b(net: str, level: int, ts: int) -> None:
        hops[0] += 1
        bus_b.apply_remote(net, level, ts)

    def to_a(net: str, level: int, ts: int) -> None:
        hops[0] += 1
        bus_a.apply_remote(net, level, ts)

    # Both buses stamp with the shared clock (CLOCK_MONOTONIC in a worker,
    # the virtual clock here), and the runtimes anchor on the same origin.
    clock = lambda: virtual_clock[0]  # noqa: E731
    bus_a = ChipNetBus(publisher=to_b, clock=clock)
    bus_b = ChipNetBus(publisher=to_a, clock=clock)
    bus_a.mark_remote(['mains'])
    bus_b.mark_remote(['mains'])

    a = _Plc(bus_a, 'mains', 'plcA', 10)
    b = _Plc(bus_b, 'mains', 'plcB', 10)
    a.rt._t0 = 0
    b.rt._t0 = 0

    msg = b'xkoin plc 3\n'
    a.host_send(msg)
    _pump(virtual_clock, [a.rt, b.rt], stop=lambda: bytes(b.out) == msg)

    assert bytes(b.out) == msg
    assert hops[0] > 0                  # it really did cross the bridge
    assert bytes(a.out) == b''


def _bridged_pair(virtual_clock, jitter_ns, stamped: bool):
    """Two buses joined by a hop that ARRIVES late by a rotating jitter, as
    the real bridge does (measured 2.6 ms min, 8 ms mean, 100 ms max on a
    loaded host). The receiver's clock is the virtual clock plus that lag at
    the moment each edge lands. With `stamped`, the hop forwards the sender's
    stamp; without it, the receiver only has its arrival time."""
    k = [0]
    lag = [0]
    bus_a: ChipNetBus
    bus_b: ChipNetBus

    def to_b(net: str, level: int, ts: int) -> None:
        lag[0] = jitter_ns[k[0] % len(jitter_ns)]
        k[0] += 1
        bus_b.apply_remote(net, level, ts if stamped else 0)

    def to_a(net: str, level: int, ts: int) -> None:
        bus_a.apply_remote(net, level, ts if stamped else 0)

    clock = lambda: virtual_clock[0]  # noqa: E731
    bus_a = ChipNetBus(publisher=to_b, clock=clock)
    bus_b = ChipNetBus(publisher=to_a, clock=clock)
    bus_a.mark_remote(['mains'])
    bus_b.mark_remote(['mains'])
    a = _Plc(bus_a, 'mains', 'plcA', 10)
    b = _Plc(bus_b, 'mains', 'plcB', 10)
    a.rt._t0 = 0
    b.rt._t0 = 0
    # The receiver's own clock runs late by the current hop lag.
    b.rt.sim_now_nanos = lambda: virtual_clock[0] + lag[0]  # type: ignore[method-assign]
    return a, b


@pytestmark_wasm
def test_bridge_jitter_breaks_an_unstamped_edge_stream(virtual_clock):
    # Half cell is 100 us at bit_period_us 200; a lag swing of 60 us to 150 us
    # is more than the half-cell margin, and the frame is lost.
    jitter = [0, 150_000, 30_000, 90_000]
    a, b = _bridged_pair(virtual_clock, jitter, stamped=False)
    msg = b'xkoin plc 4\n'
    a.host_send(msg)
    _pump(virtual_clock, [a.rt, b.rt])
    assert bytes(b.out) != msg


@pytestmark_wasm
def test_stamped_edges_survive_bridge_jitter(virtual_clock):
    # Same hop, same lag, but each edge carries the sender's stamp and the
    # receiving chip sees it at that instant: the frame decodes.
    jitter = [0, 150_000, 30_000, 90_000]
    a, b = _bridged_pair(virtual_clock, jitter, stamped=True)
    msg = b'xkoin plc 5\n'
    a.host_send(msg)
    _pump(virtual_clock, [a.rt, b.rt], stop=lambda: bytes(b.out) == msg)
    assert bytes(b.out) == msg


# ── SX1262 over a chip-to-chip ANT net ───────────────────────────────────────

SX_PINS = ['SCK', 'MOSI', 'MISO', 'NSS', 'BUSY', 'DIO1', 'RESET']

OP = {
    'SET_STANDBY': 0x80, 'SET_PACKET_TYPE': 0x8A, 'SET_RF_FREQUENCY': 0x86,
    'SET_PA_CONFIG': 0x95, 'SET_TX_PARAMS': 0x8E, 'SET_BUFFER_BASE': 0x8F,
    'SET_MOD_PARAMS': 0x8B, 'SET_PACKET_PARAMS': 0x8C, 'SET_DIO_IRQ': 0x08,
    'WRITE_BUFFER': 0x0E, 'READ_BUFFER': 0x1E, 'SET_TX': 0x83, 'SET_RX': 0x82,
    'GET_IRQ_STATUS': 0x12, 'GET_RX_BUFFER_STATUS': 0x13,
    'SET_REGULATOR_MODE': 0x96, 'SET_DIO2_AS_RF_SWITCH': 0x9D,
    'SET_DIO3_AS_TCXO': 0x97, 'CALIBRATE_IMAGE': 0x98,
}


class _GpioNet:
    """The board side of the radio: a plain level map with fan-out, standing in
    for the GPIOs QEMU would drive. ANT is deliberately NOT in here."""

    def __init__(self) -> None:
        self.level: dict[int, int] = {}
        self.runtimes: list[WasmChipRuntime] = []

    def writer(self, gpio: int, value: int) -> None:
        value &= 1
        if self.level.get(gpio) == value:
            return
        self.level[gpio] = value
        for rt in self.runtimes:
            rt.notify_pin_change(gpio, value)

    def reader(self, gpio: int) -> int:
        return self.level.get(gpio, 0)


class _Radio:
    def __init__(self, gpio_net, bus, net_id, label, base_gpio, attrs=None):
        self.net = gpio_net
        self.map = {name: base_gpio + i for i, name in enumerate(SX_PINS)}
        values = {'rssi_dbm': -80.0, 'drop_percent': 0.0,
                  'bit_period_us': SX_BIT_US, 'label': label}
        values.update(attrs or {})
        self.rt = WasmChipRuntime(
            compiled_chip('sx1262'),
            values,
            lambda _payload: None,
            pin_map=self.map,
            pin_writer=gpio_net.writer,
            pin_reader=gpio_net.reader,
            net_map={'ANT': net_id},
            net_bus=bus,
        )
        gpio_net.runtimes.append(self.rt)
        self.rt.run_chip_setup()
        self.rt.notify_pin_change(self.map['NSS'], 1)

    def xfer(self, data):
        self.rt.notify_pin_change(self.map['NSS'], 0)
        out = [self.rt.spi_transfer_byte(b) for b in data]
        self.rt.notify_pin_change(self.map['NSS'], 1)
        return out

    def cmd(self, op, args=()):
        return self.xfer([OP[op]] + list(args))

    def dio1(self) -> int:
        return self.net.reader(self.map['DIO1'])

    def configure(self, dio1_mask: int) -> None:
        self.cmd('SET_STANDBY', [0x00])
        self.cmd('SET_REGULATOR_MODE', [0x01])
        self.cmd('SET_DIO2_AS_RF_SWITCH', [0x01])
        self.cmd('SET_DIO3_AS_TCXO', [0x07, 0x00, 0x00, 0x64])
        self.cmd('CALIBRATE_IMAGE', [0xD7, 0xDB])
        self.cmd('SET_PACKET_TYPE', [0x01])
        self.cmd('SET_RF_FREQUENCY', [0x36, 0x40, 0x66, 0x66])
        self.cmd('SET_PA_CONFIG', [0x04, 0x07, 0x00, 0x01])
        self.cmd('SET_TX_PARAMS', [0x16, 0x04])
        self.cmd('SET_BUFFER_BASE', [0x00, 0x80])
        self.cmd('SET_MOD_PARAMS', [0x07, 0x04, 0x01, 0x00])
        self.cmd('SET_PACKET_PARAMS', [0x00, 0x08, 0x00, 0xFF, 0x01, 0x00])
        self.cmd('SET_DIO_IRQ', [0xFF, 0xFF, dio1_mask >> 8, dio1_mask & 0xFF,
                                 0x00, 0x00, 0x00, 0x00])


@pytestmark_wasm
def test_ant_net_carries_a_lora_frame(virtual_clock):
    """A whole SX1262 frame over an ANT net whose only members are two chips.
    The SPI side keeps its board GPIOs, so this also covers a chip that is on
    both a GPIO and a chip net at once."""
    gpio_net = _GpioNet()
    bus = ChipNetBus()
    a = _Radio(gpio_net, bus, 'air', 'radioA', 10)
    b = _Radio(gpio_net, bus, 'air', 'radioB', 30)
    rts = [a.rt, b.rt]

    a.configure(0x0001)     # TX_DONE on DIO1
    b.configure(0x0002)     # RX_DONE on DIO1
    _pump(virtual_clock, rts)

    payload = b'xkoin ping 1'
    b.cmd('SET_RX', [0xFF, 0xFF, 0xFF])
    a.cmd('WRITE_BUFFER', [0x00] + list(payload))
    a.cmd('SET_TX', [0xFF, 0xFF, 0xFF])
    _pump(virtual_clock, rts, stop=lambda: a.dio1() == 1 and b.dio1() == 1)

    irq = a.cmd('GET_IRQ_STATUS', [0, 0, 0])
    assert (irq[2] << 8 | irq[3]) & 0x0001, 'sender never raised TX_DONE'

    irq = b.cmd('GET_IRQ_STATUS', [0, 0, 0])
    status = (irq[2] << 8) | irq[3]
    assert status & 0x0002, f'receiver never raised RX_DONE (irq=0x{status:04X})'
    assert not status & 0x0040, f'receiver reported a CRC error (irq=0x{status:04X})'

    rbs = b.cmd('GET_RX_BUFFER_STATUS', [0, 0, 0])
    length, start = rbs[2], rbs[3]
    assert length == len(payload)
    got = b.cmd('READ_BUFFER', [start, 0x00] + [0] * length)
    assert bytes(got[3:3 + length]) == payload
