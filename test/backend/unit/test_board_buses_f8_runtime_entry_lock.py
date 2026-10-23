"""
Board buses F8: WasmChipRuntime serialises its entries between threads.

The workers enter a chip from two threads: QEMU's (pin edges, bus and UART
bytes) and the chip timer thread (deadlines). The ESP32 worker holds QEMU's
iothread lock on both; the STM32 worker has no such symbol, so a chip with a
timer and a pin watch could be entered from both at once, on one wasmtime
Store (seen as a guest hang on the F7 rig without the BQL). The runtime now
takes one reentrant lock on every public entry.

The row is deterministic, not a race: thread A is parked INSIDE
notify_pin_change (the gate below holds it just before the chip's watch
callback runs), and thread B fires a due timer. With the lock, B waits for A;
without it, B's timer fires while A is inside.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

pytest.importorskip("wasmtime")

FIXTURES = (Path(__file__).resolve().parents[3]
            / "frontend" / "src" / "__tests__" / "board-buses"
            / "fixtures" / "chips-abi-parity")
sys.path.insert(0, str(FIXTURES))
from abi_probe_driver import TABLE, WorkerHost  # noqa: E402


def make_host() -> WorkerHost:
    return WorkerHost(blobs={TABLE["blobName"]: bytes.fromhex(TABLE["blobHex"])})


def test_a_timer_firing_on_another_thread_waits_for_the_pin_edge_inside_the_chip():
    h = make_host()
    rt = h.rt
    # A one-shot timer 1 ms out; the clock is the host's own (WorkerHost.now).
    h.probe.call("timer_start", 1000, 0)

    inside = threading.Event()
    release = threading.Event()
    real = rt._call_indirect

    def gated(idx, *args):
        if threading.current_thread().name == "edge" and not inside.is_set():
            inside.set()
            release.wait(5)
        return real(idx, *args)

    rt._call_indirect = gated
    edge = threading.Thread(target=lambda: rt.notify_pin_change(h.pins["IN"], 1), name="edge")
    edge.start()
    assert inside.wait(5), "the edge never reached the chip"

    h.now[0] = 2_000_000
    fired = threading.Event()

    def fire() -> None:
        rt.fire_due_timers()
        fired.set()

    timer = threading.Thread(target=fire, name="timer")
    timer.start()
    try:
        assert not fired.wait(0.3), "the timer thread entered the chip while a pin edge was inside it"
    finally:
        release.set()
        edge.join(5)
        timer.join(5)
    assert fired.is_set(), "the timer never fired once the edge left"
    trace = h.probe.trace()
    assert trace[0].startswith("pin IN=1"), trace
    assert any(t.startswith("timer") for t in trace), trace


def test_a_chip_callback_re_entering_the_runtime_on_the_same_thread_passes():
    # The lock is reentrant: a watch callback that reads a pin back (the chip's
    # own vx_pin_read inside on_pin) is an entry from inside an entry.
    h = make_host()
    h.drive("IN", 1)
    h.drive("IN", 0)
    assert h.probe.trace() == ["pin IN=1", "pin IN=0"]
