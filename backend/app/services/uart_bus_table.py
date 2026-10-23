"""
uart_bus_table.py: which guest UART each chip a QEMU worker hosts is on
(project board-buses-2026-09, F6).

A custom chip or a Grove module that speaks UART runs inside the worker,
beside the guest: QEMU hands the worker every byte the firmware transmits
(picsimlab_uart_tx_event) and the chip's reply goes straight back into the
guest's RX (qemu_picsimlab_uart_receive). What the worker cannot see is the
circuit. Before F6 each chip resolved its UART once, at vx_uart_attach, from a
{gpio: uart} table the frontend built with a static pin classifier, and a
record with no table landed on Serial1 whatever the wiring: the
grove-worker-no-uart-map finding, and the reason a module wired to Serial2 on
a variant the classifier did not know was answered by the wrong port.

This table keeps the rules the tab's fabric keeps (simulation/buses/uartBus.ts,
fabric.ts), on the worker's side of the wire:

  - a registration is an IDENTITY (the runtime object), never a UART number,
    and it leaves by that identity;
  - a chip hears the controller whose TX its RX leg is wired to, and its
    replies land in the controller whose RX its TX leg is wired to. Both legs
    of one chip are on one UART on any real wiring, so one unit is kept per
    chip;
  - a chip whose legs the fabric placed on no controller (unwired, or on
    plain GPIOs the guest would have to bit-bang) hears nothing and is heard
    by nobody. The worker has no bit-timed pins, so there is no software UART
    to fall back to, and Serial1 is not a place a wire leads.

Which unit a chip is on comes from, in this order:

  1. the live routing of the pad the chip's RX leg is on, when the worker can
     read it (`resolve_tx_pad`: the ESP32 GPIO matrix). The pad the board
     TRANSMITS on carries an output signal, UnTXD_OUT, which is readable; the
     pad it receives on carries an input select the worker cannot read, so
     only the RX leg is asked. A pad the matrix does not route is NOT the end
     of the search: ESP-IDF 5 puts a UART on its IO_MUX pins without touching
     the matrix (uart_try_set_iomux_pin), so an unrouted pad falls through to
     the tab's answer;
  2. the tab's bus map (`bus_map.uart`, one entry per endpoint the fabric
     placed on this board): the unit whose TX feeds the RX leg, else the one
     whose RX reads the TX leg, from the board's pin table. An owner the map
     lists as unplaced is on no wire of this board and is silent;
  3. nothing else: a registration the map says nothing about (a record the
     tab has not placed yet, or one from a part that is not on the fabric)
     is on no unit, silent both ways. Every part that sends the worker a
     UART chip is on the fabric since F6 (CustomChipPart, the Grove
     chipPart), so a map always follows a record; the record's own word
     (a `uart_map` guessed from a static pin table, Serial1 when it had
     none) is no longer asked.

Owners link a map entry to a registration: a record's `owner` field, else its
`component_id`, the same identity the tab's registry keys the endpoint by.

Plain Python with no QEMU in it, so the ESP32 worker and the STM32 worker
(pro/backend/app/pro_boards/stm32_worker.py) share it and it is tested on its
own (test/backend/unit/test_board_buses_f6_worker_uart.py).
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Optional

# What `resolve_tx_pad` answers for a pad the matrix routes to no UART. None
# means the matrix could not be read at all.
NOT_ROUTED = -1

ResolveFn = Callable[[int], Optional[int]]


def _as_unit(v: Any) -> Optional[int]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def owner_of(record: dict) -> Optional[str]:
    """The identity a sensor record carries for the bus map: `owner` when the
    part names its fabric owner, else the canvas component id."""
    for k in ('owner', 'component_id'):
        v = record.get(k)
        if isinstance(v, str) and v:
            return v
    return None


class _Placement:
    """One endpoint of the tab's map: the controllers its legs are wired to and
    the board pads they sit on. `silent` for an unplaced owner."""
    __slots__ = ('rx_uart', 'tx_uart', 'rx_pin', 'tx_pin', 'silent')

    def __init__(self, rx_uart: Optional[int], tx_uart: Optional[int],
                 rx_pin: Optional[int], tx_pin: Optional[int], silent: bool = False) -> None:
        self.rx_uart = rx_uart
        self.tx_uart = tx_uart
        self.rx_pin = rx_pin
        self.tx_pin = tx_pin
        self.silent = silent


class _Registration:
    __slots__ = ('key', 'runtime', 'owner', 'name')

    def __init__(self, key: Any, runtime: Any, owner: Optional[str]) -> None:
        self.key = key
        self.runtime = runtime
        self.owner = owner
        # A stable order for dispatch that does not depend on the order the
        # registrations arrived in, as the tab sorts its listeners by owner.
        self.name = owner if owner else f'{type(runtime).__name__}@{id(runtime):x}'


class UartBusTable:
    """Every UART chip of one worker, and the guest UART each one is on."""

    def __init__(self, resolve_tx_pad: Optional[ResolveFn] = None) -> None:
        self._resolve = resolve_tx_pad
        # The command thread registers and applies maps while the QEMU thread
        # dispatches; the dict is swapped whole under this lock.
        self._lock = threading.Lock()
        self._regs: dict[Any, _Registration] = {}
        # owner -> placement; None until a map has said anything about UART.
        self._placement: Optional[dict[str, _Placement]] = None

    # ── registrations ──────────────────────────────────────────────────────

    def add(self, key: Any, runtime: Any, *, owner: Optional[str] = None) -> None:
        """Register `runtime` under `key`. The same key again replaces it.
        `owner` is the identity the tab's map names it by (owner_of); a
        registration is on no unit until a map names its owner."""
        reg = _Registration(key, runtime, owner or None)
        with self._lock:
            regs = dict(self._regs)
            regs[key] = reg
            self._regs = regs

    def remove(self, key: Any) -> Any:
        """Take the registration under `key` off, by identity, and return its
        runtime (None when there was none)."""
        with self._lock:
            if key not in self._regs:
                return None
            regs = dict(self._regs)
            reg = regs.pop(key)
            self._regs = regs
            return reg.runtime

    def __len__(self) -> int:
        return len(self._regs)

    def __contains__(self, key: Any) -> bool:
        return key in self._regs

    # ── the tab's map ──────────────────────────────────────────────────────

    def apply_map(self, entries: Optional[list]) -> None:
        """Replace the tab's view of which controller each owner is on.

        `entries` is the `uart` list of a `bus_map`: `{owner, rx_uart, tx_uart,
        rx_pin, tx_pin}` per endpoint the fabric placed on this board (a unit
        null when no controller is on that leg's wire), and `{unplaced:
        [owner, ...]}` for endpoints registered in the tab that are on no wire
        of this board. The whole list travels every time, so an owner that
        left is gone by being absent. None (a map with no `uart` key) leaves
        the placement as it was.
        """
        if entries is None:
            return
        placement: dict[str, _Placement] = {}
        for e in entries if isinstance(entries, list) else []:
            if not isinstance(e, dict):
                continue
            unplaced = e.get('unplaced')
            if isinstance(unplaced, list):
                for o in unplaced:
                    if isinstance(o, str) and o and o not in placement:
                        placement[o] = _Placement(None, None, None, None, silent=True)
                continue
            owner = e.get('owner')
            if not isinstance(owner, str) or not owner:
                continue
            placement[owner] = _Placement(
                _as_unit(e.get('rx_uart')), _as_unit(e.get('tx_uart')),
                _as_unit(e.get('rx_pin')), _as_unit(e.get('tx_pin')),
            )
        with self._lock:
            self._placement = placement

    def placement_of(self, owner: str) -> Optional[dict]:
        """The map's word on `owner`, for logs and tests."""
        p = (self._placement or {}).get(owner)
        if p is None:
            return None
        return {'rx_uart': p.rx_uart, 'tx_uart': p.tx_uart, 'rx_pin': p.rx_pin,
                'tx_pin': p.tx_pin, 'silent': p.silent}

    # ── dispatch ───────────────────────────────────────────────────────────

    def unit_of(self, key: Any, default: Optional[int] = None) -> Optional[int]:
        """The guest UART the chip under `key` is on right now: None when it
        is on none (silent both ways), `default` when nothing is registered
        under `key`. Asked per byte, because the guest may move a UART to
        other pads at any time."""
        reg = self._regs.get(key)
        if reg is None:
            return default
        return self._unit(reg)

    def runtimes_on(self, unit: int) -> list:
        """The runtimes that hear controller `unit`, in a stable order."""
        u = int(unit)
        found = [reg for reg in self._regs.values() if self._unit(reg) == u]
        if len(found) > 1:
            found.sort(key=lambda r: r.name)
        return [r.runtime for r in found]

    def _unit(self, reg: _Registration) -> Optional[int]:
        placement = self._placement
        p = placement.get(reg.owner) if placement is not None and reg.owner else None
        if p is None:
            # The map says nothing about this chip (none has arrived yet, or
            # it is not on the tab's fabric): on no unit. There is no unit a
            # record alone could name that a wire on the bench would lead to.
            return None
        if p.silent:
            return None
        if p.rx_pin is not None and self._resolve is not None:
            live = self._resolve(p.rx_pin)
            if live is not None and live != NOT_ROUTED:
                return int(live)
        if p.rx_uart is not None:
            return p.rx_uart
        return p.tx_uart
