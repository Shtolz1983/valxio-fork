"""Membrane keypad for every guest emulated outside the browser: the circuit,
not a scan.

Used by the ESP32 worker, the STM32 worker and the Raspberry Pi GPIO bridge.
Nothing in here knows which of them is calling: a board reports what its
firmware does to a wire (output enable, output latch) and applies the levels
that come back.

A keypad is a grid of switches; a held key shorts one ROW wire to one COLUMN
wire. The model this replaces waited for the firmware to drive a ROW and then
pulled the matching COLUMN, which is the scan hand-written sketches often do
and the opposite of the Keypad library's (rows INPUT_PULLUP, each COLUMN driven
LOW in turn, rows read back). On that library no key was ever seen
(issue #327).

The rules are the browser model's (`frontend/src/simulation/line/models/
matrix-keypad.ts`); a change to one belongs in both:

1. Held keys join wires into groups (ghosting included).
2. A group is LOW when the firmware drives any of its wires low, else HIGH
   when it drives one high, else undriven.
3. Every wire of a driven group that the firmware has released (an input) is
   set to the group's level. Every other wire goes back to its idle level.

What the firmware drives is tracked from two events every one of those hosts
delivers: the output latch (a write) and the output enable (a pinMode). A wire
is driven while its enable is set, at the latch level. That pair is exact for
both scan idioms: a sketch that toggles only pinMode() with the latch left LOW
is seen through the enable, and the Keypad library's write LOW / write HIGH /
pinMode(INPUT) through both. The latch starts at 0, the reset value on every
host here.

None of these hosts has a notion of a host-released pad: they set the level the
firmware reads on an input, and an output ignores it. So "released" here means
the idle level, which is what the pad's pull gives (a pull-down reads 0,
anything else 1: every keypad circuit idles on pull-ups).

Pure: no QEMU, no threads. The worker applies the (gpio, level) pairs the
methods return.
"""
from __future__ import annotations

from typing import Callable, Iterable


def wire_list(value) -> list[int]:
    """One entry per row or column, -1 where nothing is wired."""
    out: list[int] = []
    for v in value or []:
        try:
            n = int(v)
        except (TypeError, ValueError):
            n = -1
        out.append(n if n >= 0 else -1)
    return out


def held_keys(value) -> set[tuple[int, int]]:
    """Held keys as (row_index, column_index); malformed entries are dropped."""
    out: set[tuple[int, int]] = set()
    for k in value or []:
        try:
            r, c = int(k[0]), int(k[1])
        except (TypeError, ValueError, IndexError):
            continue
        if r >= 0 and c >= 0:
            out.add((r, c))
    return out


class MatrixKeypad:
    def __init__(self, rows: Iterable, cols: Iterable,
                 pull_of: Callable[[int], int] = lambda _gpio: 1) -> None:
        self.rows = wire_list(rows)
        self.cols = wire_list(cols)
        self.wires: list[int] = list(dict.fromkeys(
            p for p in self.rows + self.cols if p >= 0))
        self.held: set[tuple[int, int]] = set()
        self._pull_of = pull_of
        self._enable: dict[int, int] = {}
        self._latch: dict[int, int] = {}
        # Last level set on each wire's input; None = never set.
        self._applied: dict[int, int | None] = {p: None for p in self.wires}

    # ── firmware events ────────────────────────────────────────────────────

    def on_latch(self, gpio: int, level: int) -> list[tuple[int, int]]:
        if gpio not in self._applied:
            return []
        self._latch[gpio] = 1 if level else 0
        return self._settle()

    def on_enable(self, gpio: int, enabled: int) -> list[tuple[int, int]]:
        if gpio not in self._applied:
            return []
        was = self._enable.get(gpio, 0)
        self._enable[gpio] = 1 if enabled else 0
        if was and not enabled:
            # The firmware just let go of this wire. Forget what WE last set on
            # it: while it was an output, the host's stored input value was not
            # what the guest read, and on some of them it was overwritten by
            # the guest's own output latch (the F1 STM32 map returns the raw
            # IDR, which stm32_gpio_update_outputs writes while the pin drives).
            # Without this, a wire released back to a level the model already
            # believes it set would never be re-asserted, and the guest would
            # read whatever it last drove instead of the matrix.
            self._applied[gpio] = None
        return self._settle()

    # ── canvas events ──────────────────────────────────────────────────────

    def set_held(self, keys) -> list[tuple[int, int]]:
        self.held = held_keys(keys)
        return self._settle()

    def idle_levels(self) -> list[tuple[int, int]]:
        """Every wire at its idle level, for install and a guest reset."""
        self._enable.clear()
        self._latch.clear()
        out = []
        for p in self.wires:
            lvl = self._idle(p)
            self._applied[p] = lvl
            out.append((p, lvl))
        return out

    # ── the circuit ────────────────────────────────────────────────────────

    def drive_of(self, gpio: int) -> int | None:
        """0 or 1 while the firmware drives the wire, None while it is an input."""
        if not self._enable.get(gpio, 0):
            return None
        return self._latch.get(gpio, 0)

    def solve(self) -> dict[int, int | None]:
        """Wire -> level it must read (0/1), or None when it is left alone."""
        parent = {p: p for p in self.wires}

        def find(p: int) -> int:
            root = p
            while parent[root] != root:
                root = parent[root]
            parent[p] = root
            return root

        for r, c in self.held:
            a = self.rows[r] if r < len(self.rows) else -1
            b = self.cols[c] if c < len(self.cols) else -1
            if a < 0 or b < 0:
                continue
            parent[find(a)] = find(b)

        group: dict[int, int] = {}
        for p in self.wires:
            d = self.drive_of(p)
            if d is None:
                continue
            root = find(p)
            if d == 0 or root not in group:
                group[root] = d

        return {p: (group.get(find(p)) if self.drive_of(p) is None else None)
                for p in self.wires}

    def _idle(self, gpio: int) -> int:
        return 0 if self._pull_of(gpio) == 2 else 1

    def _settle(self) -> list[tuple[int, int]]:
        changes = []
        for p, target in self.solve().items():
            if target is None:
                if self.drive_of(p) is not None:
                    # The firmware drives it: its input level is not read, and
                    # the next release must start from a known idle level.
                    continue
                target = self._idle(p)
            if self._applied[p] != target:
                self._applied[p] = target
                changes.append((p, target))
        return changes
