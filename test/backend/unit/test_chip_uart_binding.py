"""A custom chip's UART is the wiring's, not the chip's.

Until board-buses F6 the runtime picked the guest UART itself: the tab sent a
`uart_map` ({gpio: uart}) guessed from a static pin table, the runtime
resolved its vx_uart_config rx / tx handles through it at vx_uart_attach, and
a chip nothing matched landed on Serial1 (a CHIP_UART constant). The tab's bus
fabric now says which controller each pad's wire reaches, per board, and the
worker's bus table (uart_bus_table.py, test_board_buses_f6_worker_uart.py)
answers per byte; the runtime only records the config and hands every
vx_uart_write to its writer as bytes.

Fixture: the KQ-130F model, a 9600 8N1 module, in test/fixtures/chip-nets.

Run from the repo root:
    pytest test/backend/unit/test_chip_uart_binding.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend/ is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

pytest.importorskip('wasmtime', reason='chip runtime needs wasmtime')

import app.services.wasm_chip_runtime as runtime_mod  # noqa: E402
from app.services.wasm_chip_runtime import WasmChipRuntime  # noqa: E402

# The fixture compiler sits next to this file; the unit directory is a
# package, so it is reached by path rather than through pytest's rootdir.
sys.path.insert(0, str(Path(__file__).parent))
from chip_fixtures import chips_available, compiled_chip  # noqa: E402

pytestmark = pytest.mark.skipif(not chips_available(),
                                reason='wasi-sdk not available to compile the chip fixtures')

# The KQ-130F wiring in the xKoin proof: the module's RX on the board's TX2
# and its TX on the board's RX2.
PIN_MAP = {'TX': 18, 'RX': 17}


def _runtime(**extra):
    sent: list[bytes] = []
    rt = WasmChipRuntime(
        compiled_chip('kq130f'),
        {'label': 'kq130f', 'bit_period_us': 200.0},
        lambda _payload: None,
        pin_map=PIN_MAP,
        uart_writer=lambda data: sent.append(bytes(data)),
        **extra,
    )
    rt.run_chip_setup()
    return rt, sent


def test_the_attach_records_the_config_and_names_no_uart():
    rt, _sent = _runtime()
    assert rt.uart_config is not None, 'the model did not attach a UART at all'
    assert {'rx', 'tx', 'baud_rate', 'on_rx_byte'} <= set(rt.uart_config)
    assert not hasattr(rt, 'uart_id')


def test_the_runtime_has_no_uart_of_its_own():
    """No Serial1 constant to land on, and no `uart_map` to resolve through: a
    record that still carries the pre-F6 table is refused, not honoured."""
    assert not hasattr(runtime_mod, 'CHIP_UART')
    with pytest.raises(TypeError):
        _runtime(uart_map={17: 2})


def test_writes_reach_the_writer_as_bytes_only(monkeypatch):
    """A module only writes to its UART when it has decoded a burst off the
    LINE, so this drives a real one: chip A is fed by its host, the frame
    crosses the net, and chip B forwards the payload to its writer. The models
    measure edge intervals, hence the virtual clock."""
    from app.services.wasm_chip_runtime import ChipNetBus

    now = [0]
    monkeypatch.setattr(WasmChipRuntime, 'sim_now_nanos', lambda _self: now[0])
    bus = ChipNetBus()

    def _plc(label, base):
        sent: list[bytes] = []
        rt = WasmChipRuntime(
            compiled_chip('kq130f'),
            {'label': label, 'bit_period_us': 200.0, 'line_noise_percent': 0.0},
            lambda _payload: None,
            pin_map={'TX': base, 'RX': base + 1},
            uart_writer=lambda data: sent.append(bytes(data)),
            net_map={'LINE': 'mains'},
            net_bus=bus,
        )
        rt.run_chip_setup()
        return rt, sent

    a_rt, a_sent = _plc('plcA', 10)
    b_rt, b_sent = _plc('plcB', 30)

    msg = b'xkoin plc 1\n'
    for byte in msg:
        a_rt.feed_uart_byte(byte)

    for _ in range(4_000_000):
        if b''.join(b_sent) == msg:
            break
        deadlines = [d for d in (a_rt.next_timer_deadline(), b_rt.next_timer_deadline())
                     if d is not None]
        if not deadlines:
            break
        now[0] = max(now[0], min(deadlines))
        a_rt.fire_due_timers()
        b_rt.fire_due_timers()

    assert b''.join(b_sent) == msg, b_sent
    assert a_sent == []                 # a module never hears its own burst
