"""Unit tests for the QEMU worker's membrane keypad (matrix_keypad).

Same rules as the browser model (frontend/src/simulation/line/models/
matrix-keypad.ts, tested in line/__tests__/matrixKeypad.test.ts). The scan
order that matters most is the Keypad library's: rows INPUT_PULLUP, each column
driven LOW in turn, rows read back (issue #327).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_here = Path(__file__).resolve().parent.parent / "app" / "services" / "matrix_keypad.py"
_spec = importlib.util.spec_from_file_location("matrix_keypad", _here)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["matrix_keypad"] = _mod
_spec.loader.exec_module(_mod)
MatrixKeypad = _mod.MatrixKeypad

ROWS = [13, 12, 14, 27]
COLS = [26, 25, 33, 32]


class Guest:
    """The firmware side: what QEMU reports, and what the pins read."""

    def __init__(self, kp: MatrixKeypad) -> None:
        self.kp = kp
        self.inputs = dict(kp.idle_levels())

    def _apply(self, changes):
        for g, lvl in changes:
            self.inputs[g] = lvl

    def output(self, gpio):
        self._apply(self.kp.on_enable(gpio, 1))

    def input(self, gpio):
        self._apply(self.kp.on_enable(gpio, 0))

    def write(self, gpio, level):
        self._apply(self.kp.on_latch(gpio, level))

    def hold(self, *keys):
        self._apply(self.kp.set_held([list(k) for k in keys]))

    def read(self, gpio):
        return self.inputs[gpio]


def keypad_library_scan(g: Guest) -> set[tuple[int, int]]:
    """Keypad::scanKeys, call for call."""
    seen = set()
    for r in ROWS:
        g.input(r)
    for ci, c in enumerate(COLS):
        g.output(c)
        g.write(c, 0)
        for ri, r in enumerate(ROWS):
            if g.read(r) == 0:
                seen.add((ri, ci))
        g.write(c, 1)
        g.input(c)
    return seen


def row_scan(g: Guest) -> set[tuple[int, int]]:
    """The hand-written idiom: pinMode toggles only, the latch stays LOW."""
    seen = set()
    for c in COLS:
        g.input(c)
    for ri, r in enumerate(ROWS):
        g.output(r)
        for ci, c in enumerate(COLS):
            if g.read(c) == 0:
                seen.add((ri, ci))
        g.input(r)
    return seen


def test_keypad_library_scan_sees_the_held_key():
    g = Guest(MatrixKeypad(ROWS, COLS))
    assert keypad_library_scan(g) == set()
    g.hold((2, 2))
    assert keypad_library_scan(g) == {(2, 2)}
    # Every later pass too: after the first, the column latch is HIGH when it
    # goes OUTPUT, so this exercises the write LOW path, not the reset latch.
    assert keypad_library_scan(g) == {(2, 2)}
    g.hold()
    assert keypad_library_scan(g) == set()


def test_row_scan_sees_the_held_key():
    g = Guest(MatrixKeypad(ROWS, COLS))
    g.hold((3, 0))
    assert row_scan(g) == {(3, 0)}
    assert row_scan(g) == {(3, 0)}


def test_every_key_of_the_grid():
    for r in range(4):
        for c in range(4):
            g = Guest(MatrixKeypad(ROWS, COLS))
            g.hold((r, c))
            assert keypad_library_scan(g) == {(r, c)}
            assert row_scan(g) == {(r, c)}


def test_ghosting_is_the_real_membrane():
    g = Guest(MatrixKeypad(ROWS, COLS))
    g.hold((0, 0), (0, 1), (1, 0))
    # Three corners of a rectangle held: the fourth reads as held too.
    assert keypad_library_scan(g) == {(0, 0), (0, 1), (1, 0), (1, 1)}


def test_a_wire_the_firmware_drives_is_never_set():
    kp = MatrixKeypad(ROWS, COLS)
    g = Guest(kp)
    g.hold((0, 0))
    g.output(COLS[0])
    g.write(COLS[0], 0)
    g.output(ROWS[0])  # both ends driven: nothing to answer on either
    assert kp.solve()[ROWS[0]] is None
    assert kp.solve()[COLS[0]] is None


def test_release_returns_to_the_pull():
    kp = MatrixKeypad(ROWS, COLS, pull_of=lambda gpio: 2 if gpio == ROWS[1] else 1)
    g = Guest(kp)
    assert g.read(ROWS[1]) == 0  # a pull-down idles low
    g.hold((1, 0))
    g.output(COLS[0])
    g.write(COLS[0], 1)
    assert g.read(ROWS[1]) == 1  # shorted to a driven HIGH
    g.input(COLS[0])
    assert g.read(ROWS[1]) == 0


def test_a_released_wire_is_always_re_asserted():
    # A host whose stored input value is clobbered by the guest's own output
    # latch while the wire is an output: the F1 STM32 map returns the raw IDR,
    # which the guest's ODR write goes into. When the firmware releases the
    # wire, the model must re-assert the level rather than trust its memo.
    kp = MatrixKeypad(ROWS, COLS)
    g = Guest(kp)
    g.hold((0, 0))
    g.output(COLS[0])
    g.write(COLS[0], 0)
    assert g.read(ROWS[0]) == 0
    g.input(COLS[0])
    assert g.read(ROWS[0]) == 1
    # The guest drives the ROW itself, high, and lets go again. Nothing about
    # the matrix changed, so a memo-only model would stay silent and leave the
    # wire reading the guest's old HIGH.
    g.output(ROWS[0])
    g.write(ROWS[0], 1)
    g.inputs[ROWS[0]] = 1  # the host's stored value, clobbered by the latch
    g.output(COLS[0])
    g.write(COLS[0], 0)
    g.input(ROWS[0])
    assert g.read(ROWS[0]) == 0


def test_unwired_lines_are_ignored():
    kp = MatrixKeypad([13, -1, 14, 27], [26, 25, 33, -1])
    g = Guest(kp)
    g.hold((1, 0), (0, 3))  # both keys touch an unwired line
    g.output(26)
    assert all(lvl == 1 for p, lvl in g.inputs.items() if p != 26)
    assert -1 not in kp.wires
