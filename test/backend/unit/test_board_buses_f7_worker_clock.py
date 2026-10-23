"""
test_board_buses_f7_worker_clock.py: the custom chips a QEMU worker hosts run
on the GUEST's clock (project/board-buses-2026-09, F7: "the worker's clock is
QEMU's").

The ESP32 worker runs unmodified on the repro suite's rig
(fixtures/board_buses_worker/fake_libqemu.py, libqemu replaced at the ctypes
boundary), with the one symbol this is about switched on: qemu_clock_get_ns
(QEMU_CLOCK_VIRTUAL), moved by the test through the `clock` guest op. The chip
is clock-probe.c: a 1 ms repeating timer that logs vx_sim_now_nanos at every
fire, and a pin watch that logs it at every edge.

Before F7 the runtime's clock was the worker's own monotonic time: with the
guest standing still the chip kept ticking on the wall clock, and a chip that
measured the sketch's pulses measured the host's lag. Now:

  - while the guest's clock stands, nothing fires, however long the wall waits;
  - when it moves, every period it passed fires once, and each fire reads its
    own deadline as now;
  - an edge the guest drives reads the guest's instant.
"""
from __future__ import annotations

import base64
import os

import pytest

pytest.importorskip('wasmtime', reason='the custom-chip runtime needs wasmtime')

from .test_board_buses_repro_worker import FIXTURES, Worker  # noqa: E402

TRIG = 5


def clock_chip() -> dict:
    return {
        'sensor_type': 'custom-chip', 'pin': 400,
        'wasm_b64': base64.b64encode((FIXTURES / 'clock-probe.wasm').read_bytes()).decode('ascii'),
        'attrs': {}, 'component_id': 'clk', 'pin_map': {'TRIG': TRIG}, 'nets': [], 'uart_map': {},
    }


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
    made: list[Worker] = []

    def make(**kw) -> Worker:
        w = Worker(tmp_path, **kw)
        made.append(w)
        w.boot()
        return w

    yield make
    for w in made:
        w.close()


def ticks(w: Worker) -> list[int]:
    return [int(t.split('now=')[1]) for t in w.chip_log() if t.startswith('tick now=')]


def edges(w: Worker) -> list[int]:
    return [int(t.split('now=')[1]) for t in w.chip_log() if t.startswith('edge now=')]


def test_setup_the_chip_loads_with_its_timer_armed(worker):
    w = worker(sensors=[clock_chip()])
    assert 'clock probe ready' in w.chip_log()


def test_while_the_guest_clock_stands_the_chip_timer_does_not_fire(worker):
    """The negative control of the whole change: on the wall clock a 1 ms
    timer fires some 200 times in this wait."""
    w = worker(sensors=[clock_chip()])
    w.guest('clock', ns=0)
    assert not w.wait_for(lambda: bool(ticks(w)), 0.25), ticks(w)[:5]


def test_when_the_guest_clock_moves_every_period_it_passed_fires_at_its_deadline(worker):
    w = worker(sensors=[clock_chip()])
    w.guest('clock', ns=3_000_000)
    assert w.wait_for(lambda: len(ticks(w)) >= 3, 3.0), ticks(w)
    assert ticks(w)[:3] == [1_000_000, 2_000_000, 3_000_000]
    # And no further: the clock has not moved past the third deadline.
    assert not w.wait_for(lambda: len(ticks(w)) > 3, 0.25), ticks(w)


def test_an_edge_the_guest_drives_reads_the_guest_instant(worker):
    w = worker(sensors=[clock_chip()])
    w.guest('clock', ns=7_500_000)
    # Let the timer thread fire the seven periods the jump passed before the
    # guest drives the pad: on the rig nothing plays the iothread lock the
    # worker takes around a timer fire, so the two threads would otherwise
    # enter the chip's wasm at once, which QEMU's BQL never lets happen.
    assert w.wait_for(lambda: len(ticks(w)) >= 7, 3.0), ticks(w)
    w.pin(TRIG, 1)
    assert w.wait_for(lambda: bool(edges(w)), 3.0), w.chip_log()
    assert edges(w)[0] == 7_500_000
