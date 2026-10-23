"""
Board buses F7: the chip ABI in the QEMU WORKER host (WasmChipRuntime and the
adapters the workers put around it), against the cross-host table.

A custom chip has to behave like the chip it models, the same in every host.
This suite is one of three that replay the SAME table against the SAME
artifact (frontend/src/__tests__/board-buses/fixtures/chips-abi-parity/):

  board-buses-abi-parity.test.ts                          browser
  this file                                               QEMU worker
  velxio-prod pro/backend/tests/unit/
      test_board_buses_abi_parity_pi.py                   Linux boards

The table is written from backend/sdk/velxio-chip.h and the browser runtime's
documented contracts, not from this runtime, so the hosts fail rather than
agree on a wrong answer. The chip is driven the way esp32_worker.py drives
one (fixtures' abi_probe_driver.WorkerHost): spi_transfer_byte behind
spi_cs_active, the I2C bus table into WasmChipI2CSlave, feed_uart_byte,
notify_pin_change and fire_due_timers on the clock the worker hands over.

The two worker divergences PHASES.md named are rows of this table: a
completed SPI transfer used to reach on_done a second time from the chip's
vx_spi_stop, and a repeated START never reached on_connect. The rows that
close them are also pinned below on their own, driven the same way, so the
guard reads as the finding does.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("wasmtime")

from app.services.wasm_chip_slave import WasmChipI2CSlave  # noqa: E402

FIXTURES = (Path(__file__).resolve().parents[3]
            / "frontend" / "src" / "__tests__" / "board-buses"
            / "fixtures" / "chips-abi-parity")
sys.path.insert(0, str(FIXTURES))
from abi_probe_driver import (  # noqa: E402
    I2C_FINISH, I2C_READ, I2C_START_RECV, I2C_START_SEND, I2C_WRITE,
    TABLE, WorkerHost, replay, scenarios_for,
)

SCENARIOS = {s["name"]: s for s in scenarios_for("worker")}


def make_host() -> WorkerHost:
    return WorkerHost(blobs={TABLE["blobName"]: bytes.fromhex(TABLE["blobHex"])})


def test_the_committed_wasm_was_built_from_the_committed_source():
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    sha = hashlib.sha256((FIXTURES / "abi-probe.c").read_bytes()).hexdigest()
    assert sha == manifest["abi-probe"]["sourceSha256"]


def test_setup_the_chip_loads_and_declares_everything():
    h = make_host()
    assert "abi probe ready" in h.logs
    assert h.rt.spi_handle_count() == 2
    assert h.rt.i2c_addresses == [0x42, 0x43]
    assert h.rt.uart_config is not None


@pytest.mark.parametrize("name", list(SCENARIOS), ids=lambda n: n.split(":")[0] + ":" + n.split(":")[1][:40].strip())
def test_answers_every_row_of_the_cross_host_table(name):
    h = make_host()
    bad = replay(h, SCENARIOS[name])
    assert bad == [], "\n".join(bad)


# ── The two worker divergences, on their own ─────────────────────────────


def test_a_completed_transfer_reports_on_done_once_whatever_the_chip_stops_afterwards():
    """PHASES.md F7: the worker fired on_done twice for one transfer. The
    documented idiom stops the transfer from the chip's CS watch, so every
    chip written to the reference used to see its frame twice."""
    h = make_host()
    h.probe.call("spi_arm", 0, 3, 0xA0)
    h.drive("CS", 1)
    h.drive("CS", 0)
    assert h.spi([1, 2, 3]) == [0xA0, 0xA1, 0xA2]
    h.drive("CS", 1)
    h.probe.call("spi_stop", 0)
    done = [t for t in h.probe.trace() if t.startswith("spi_done")]
    assert done == ["spi_done h=0 n=3 buf=own"]


def test_a_repeated_start_reaches_on_connect_with_the_read_direction():
    """PHASES.md F7: the worker did not re-emit on_connect on an I2C repeated
    START, so write-then-read never told the chip the read phase began. The
    events come as QEMU's bridge delivers them to the slave adapter."""
    h = make_host()
    slave = WasmChipI2CSlave(0x42, h.rt)
    assert slave.handle_event(I2C_START_SEND) == 0
    assert slave.handle_event(I2C_WRITE | (0x05 << 8)) == 0
    assert slave.handle_event(I2C_START_RECV) == 0
    assert slave.handle_event(I2C_READ) == 0x35
    slave.handle_event(I2C_FINISH)
    assert h.probe.trace() == [
        "i2c_connect slot=0 addr=42 read=0", "i2c_write slot=0 05",
        "i2c_connect slot=0 addr=42 read=1", "i2c_read slot=0 ->35", "i2c_stop slot=0",
    ]


def test_the_slave_adapter_serves_every_address_the_chip_attached():
    """A chip that attaches two addresses is two targets; the adapter hands
    each START to the callbacks of the address it names."""
    h = make_host()
    slave = WasmChipI2CSlave(0x42, h.rt)
    assert slave.handle_event(I2C_START_SEND, 0x43) == 0
    assert slave.handle_event(I2C_WRITE | (0x02 << 8), 0x43) == 0
    slave.handle_event(I2C_FINISH, 0x43)
    assert slave.handle_event(I2C_START_RECV, 0x43) == 0
    assert slave.handle_event(I2C_READ, 0x43) == 0x42
    slave.handle_event(I2C_FINISH, 0x43)
    assert h.probe.trace() == [
        "i2c_connect slot=1 addr=43 read=0", "i2c_write slot=1 02", "i2c_stop slot=1",
        "i2c_connect slot=1 addr=43 read=1", "i2c_read slot=1 ->42", "i2c_stop slot=1",
    ]


def test_the_runtime_reads_the_clock_it_was_given():
    """The worker hands the runtime QEMU's virtual clock; vx_sim_now_nanos
    and the timer deadlines are on it, never on the host's."""
    h = make_host()
    h.now[0] = 7_000_000
    assert h.probe.call("now_lo") == 7_000_000
    h.probe.call("timer_start", 250, 0)
    assert h.rt.next_timer_deadline() == 7_250_000
    h.clock(7_249_999)
    assert h.probe.trace() == []
    h.clock(7_250_000)
    assert h.probe.trace() == ["timer now=7250000"]
