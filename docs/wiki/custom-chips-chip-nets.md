# Custom chips on ESP32 — chip-to-chip nets and UART binding

> **Why this exists**: on a browser board (AVR, RP2040) two custom chips wired
> to each other share one `PinManager` key, so a write by one is seen by the
> other. On an ESP32 board the chip runs in the backend QEMU worker
> ([custom-chips-esp32-backend-runtime.md](./custom-chips-esp32-backend-runtime.md)),
> which only knew the board GPIOs a chip pin was wired to. A chip pin wired
> only to another chip's pin had nothing to stand on. This page documents the
> net bus that carries such pins inside one worker, the bridge that carries
> them between two workers, and the limits measured on the way. Landed in
> PR #324 (2026-09). The UART binding that landed with it (a `uart_map` the
> frontend classified pin by pin, `CHIP_UART` as the fallback) was replaced
> by the bus fabric in `board-buses-2026-09` F6; the UART section below says
> what a chip's UART is on today.

---

## Table of contents

- [The problem](#the-problem)
- [Fan-out inside one worker](#fan-out-inside-one-worker)
- [Bridging two workers](#bridging-two-workers)
- [UART binding](#uart-binding)
- [Two faults fixed on the way](#two-faults-fixed-on-the-way)
- [What the bridge costs](#what-the-bridge-costs)
- [Limits that remain](#limits-that-remain)
- [Files and tests](#files-and-tests)

---

## The problem

`CustomChipPart.ts` takes an ESP32-only branch that ships the chip's WASM to
the backend worker with `pin_map = {chip pin name: ESP32 GPIO}` resolved from
the diagram's wires. A chip pin wired only to another chip's pin has no GPIO,
so it was absent from that map, and `wasm_chip_runtime.py` dropped the watch:

```python
def vx_pin_watch(handle, edge, cb_idx, user_data):
    p = self._pins[handle]
    if p["gpio"] is None:
        return   # no GPIO, no edges to detect
```

Putting a board GPIO on the net did not rescue it either. A chip's
`vx_pin_write` calls `qemu_picsimlab_set_pin`, which drives a pin *into* the
guest; the worker's `_on_pin_change` fires only for GPIOs the firmware drives
*out*. One chip's write never re-entered the other chip's watch.

Two ESP32 boards are two QEMU subprocesses. `Interconnect.ts` bridges board
pin to board pin over the WebSocket, with a byte-level shortcut for hardware
UART because bit-level transport over that hop is slow. Nothing joined two
chips living in two workers.

Separately, `vx_uart_attach` bound to one fixed UART whatever the diagram
said, so a module wired to Serial2 heard what the sketch printed on Serial1.

## Fan-out inside one worker

`chipNets.ts` already computes net identity: union-find over the diagram's
wires, one canonical id per net. `resolveChipNetMembers` exposes that in a
form the worker can act on, and `CustomChipPart.ts` sends it in the
custom-chip payload as `nets`, a list of `{pin, net, remote}`.

Unlike `resolveChipNetKey`, it does not skip a net that carries a board pin.
On the backend the GPIO behaviour stays and the chip members are driven as
well, which is what lets one board's firmware and two chips sit on one line.

`ChipNetBus` in `wasm_chip_runtime.py` holds one level per net and the
members on it. One bus per worker, shared by every chip on the board.

- `vx_pin_write` on any member sets the net level and fires every other
  member's `vx_pin_watch` callbacks, with edge detection per member, so a
  member already reading the new level fires nothing.
- `vx_pin_read` returns the net level when the pin has no GPIO. With a GPIO
  the live QEMU value still wins.
- A re-entrancy guard stops a member that writes back from inside its own
  callback from recursing: the nested write still sets the level, it just
  does not fan out a second time.

A payload with no `nets` builds no bus at all, so an older frontend and a
GPIO-only chip behave exactly as before.

## Bridging two workers

`chipNets.ts` knows which board owns each chip (the board its pins reach
through the wires) and marks a net `remote` when its chip members have more
than one owner board.

The worker publishes only those nets, as `chip_net` events carrying the
sender's `time.monotonic_ns` stamp. `Interconnect.ts` relays each one to every
other bound ESP32 board as an `esp32_chip_net` command; the receiving worker
applies it to its own bus and never republishes it, so one edge cannot echo
back and forth. A board with no member for that net id ignores the message.
Nets local to one worker never touch the WebSocket.

The route goes through the frontend because the two workers have no channel
to each other: each is a subprocess of the FastAPI app addressed by its own
WebSocket client id, and only the frontend holds the diagram and so knows
which boards share a net.

```
worker A ──chip_net──▶ backend ──WS──▶ browser Interconnect ──WS──▶ backend ──esp32_chip_net──▶ worker B
```

The receiving worker logs one-way latency every 200 hops
(`[custom-chip chip_net] N hops, one-way us: min= avg= max=`). Both ends read
`CLOCK_MONOTONIC`, which is system-wide on Linux, so the subtraction is a
real elapsed time.

## UART binding

The chip names its own RX and TX pins in `vx_uart_config`, and `pin_map`
already turns those into GPIOs. Which guest UART those GPIOs belong to is
decided from the wiring, in the worker's `uart_bus_table.py`
(`backend/app/services/`), in this order:

1. the live routing of the pad the chip's RX leg is on, when the worker can
   read it (the ESP32 GPIO matrix carries the `UnTXD_OUT` signal of the pad
   the board transmits on; a pad the matrix does not route falls through,
   because ESP-IDF 5 puts a UART on its IO_MUX pins without touching the
   matrix);
2. the `uart` half of the bus map the tab sends (`bus_map.uart`): one entry
   per endpoint the fabric placed on this board, with the unit whose TX
   feeds the chip's RX leg and the one whose RX its TX leg reaches. The tab
   reads a user chip's pads by running its `chip_setup` in an inert instance
   (`customChips/chipUartPads.ts`) and places them like any part's;
3. nothing. A chip whose legs the fabric placed on no controller (unwired,
   or on plain GPIOs the guest would have to bit-bang) hears nothing and is
   heard by nobody. The worker has no bit-timed pins, so there is no
   software UART there, and Serial1 is not a place a wire leads.

The worker dispatches `uart_tx` only to the chip on that unit, and a chip's
`vx_uart_write` lands in that unit's RX. There is no `uart_map` in the
sensor record, no `CHIP_UART` and no fallback to UART0 or Serial1: a chip
drawn to GPIO 1 and 3 on an ESP32 is on UART0, the console, because that is
what the diagram says. The model, the diagnostics and the same rules for the
in-browser engines are in [board-buses.md](./board-buses.md).

## Two faults fixed on the way

**A custom chip on an ESP32 board was not taking the backend path at all.**
`detectSimulatorKind` identifies an ESP32 host by `simulator.sendPinEvent`,
but `Esp32BridgeShim` only had `setPinState`. Every chip was classified
`unknown` and fell through to the browser chip runtime: the chip ran in the
tab while its firmware ran in QEMU. SPI still worked, because the frontend SPI
bridge answers the worker's `spi_event` asynchronously, which is why nothing
looked obviously broken. The shim now answers to both names. Every custom
chip on an ESP32 board therefore moved from the browser runtime to the worker
runtime with PR #324.

**The pin map carried synthetic pin numbers.** A chip pin with no board GPIO
on its net resolves to a browser-side PinManager key of 100000 and up. The
ESP32 branch copied anything non-negative into `pin_map`, so the worker would
have handed 100000 to `qemu_picsimlab_set_pin`. Synthetic numbers are now
filtered out; such a pin belongs to `nets` or to nothing.

## What the bridge costs

Measured with two ESP32-S3 boards in two workers, an SX1262 model on each,
`ANT` pins wired together (the fixture under `test/fixtures/chip-nets/`).

One-way time from the receiving worker, over 2600 hops:

| min | avg | max |
|---|---|---|
| 2.3 ms | 5.0 ms | 24.2 ms |

Change in edge spacing across the hop, from the browser. The absolute delay
does not break a self-clocked protocol; what matters is how much the gap
between two consecutive edges moves.

| bit period | half cell | p99 change in spacing | decoded? |
|---|---|---|---|
| 5 000 us | 2.5 ms | 2.06 ms | no |
| 40 000 us | 20 ms | 3.15 ms | 11 of 12 frames |

A Manchester decoder tolerates a half-cell shift per interval. At 2.5 ms the
p99 is outside that margin; at 20 ms nearly every cell lands inside it and
only the tail (max 24 ms one way) corrupts a frame now and then. Two things
set that floor: the bridge's p99 of about 3 ms, and the sender's own timer
thread, a `threading.Event.wait` loop that overshoots a 2.5 ms target to
3.3 ms at p99. Both are host scheduling.

Those numbers were taken before edges carried a stamp. Since PR #324's
follow-ups every published edge carries the sender's `CLOCK_MONOTONIC`
instant (a timer callback stamps its scheduled deadline, not the thread's
wake-up time) and the receiving chip sees the edge at that instant, so the
hop's jitter no longer reaches the bit timing: on the same loaded host the
KQ-130F pair delivered 7 of 7 frames at a 40 ms bit period with one-way
latency between 9 ms and 65 ms. What still bounds a bridged protocol is
throughput (each edge is two WebSocket messages) and ordering, which the
sockets preserve.

## Limits that remain

- **The worker places edges with a Python sleep.** `_chip_timer_thread`
  waits against the guest's virtual clock in naps of up to 20 ms and then
  fires due timers, so the transmitter's own edges carry host jitter before
  the bridge adds any (the callback still reads its exact deadline). The
  browser chip runtime puts each deadline on the engine's event queue at its
  guest cycle and has no such jitter.
- **Every bridged edge is two WebSocket messages.** A protocol that toggles a
  line quickly saturates that path first, and a background tab widens the
  latency. The latency no longer reaches the bit timing, though: every edge
  travels with the sender's `CLOCK_MONOTONIC` stamp, the workers on one host
  share that clock, and the receiving chip sees the edge at that instant
  (`ChipNetBus.apply_remote`), so a self-clocked protocol measures the
  spacing the sender drove and the hop only delays the frame. Measured on a
  loaded host before the stamp: 2.6 ms min, 8 ms mean, 101 ms max one way,
  and the KQ-130F receiver never locked; with it, the frames decode.
- **No resynchronisation.** A level change is a message, not a state sync. If
  one is dropped the two workers disagree until the next edge.
- **Browser boards join the net too.** A chip net between a chip on an ESP32
  board and one on an AVR or RP2040 board (or two browser boards) is carried
  by `Interconnect.ts`: the browser endpoints share `syntheticNetPin(net)` on
  their board's PinManager, a worker-hosted board keeps its bus, and a level
  change on any of them is mirrored to the others once
  (`resolveCrossBoardChipNets`).
- **Last-writer-wins, not a bus model.** Two chips driving opposite levels do
  not produce contention or a wired-AND; the later write sets the level. A
  chip that expects open-drain behaviour will not get it.
- **One worker slot per chip.** Each chip registers on its own synthetic
  slot (`chipVirtualPin`, from 0x1000), so live attribute updates and a
  detach reach that chip. A chip placed on the canvas while the guest runs
  loads at once through the live `sensor_attach` command, and one removed
  leaves every dispatch list and the net bus.
- **The power-line fixture transmits across the bridge but does not decode.**
  The KQ-130F pair was run at the 40 ms bit period: the chip was confirmed
  on UART2 (the log lines of the pre-F6 `uart_map` binding), the sender
  framed onto LINE and the bridge carried the edges, but the receiver never
  detected a frame start. Not chased further. The first thing to look at is
  the KQ model's 4 ms UART gap timer, which shares the worker timer thread
  that has to place the LINE edges.

## Files and tests

| File | Role |
|---|---|
| `frontend/src/simulation/customChips/chipNets.ts` | `resolveChipNetMembers`, `resolveChipOwnerBoardId` |
| `frontend/src/simulation/parts/CustomChipPart.ts` | sends `nets` and `component_id`, filters synthetic pins; the chip's UART placement travels in the bus map ([board-buses.md](./board-buses.md)) |
| `frontend/src/simulation/Interconnect.ts` | `ensureChipNetHooks`, the cross-board relay |
| `frontend/src/simulation/Esp32Bridge.ts` | `onChipNet`, `sendChipNet` |
| `frontend/src/store/useSimulatorStore.ts` | `Esp32BridgeShim.sendPinEvent` |
| `backend/app/services/wasm_chip_runtime.py` | `ChipNetBus`, net-aware `vx_pin_*` |
| `backend/app/services/uart_bus_table.py` | which guest UART each hosted chip is on, from the live routing and the tab's bus map |
| `backend/app/services/esp32_worker.py` | bus creation, `chip_net` command, per-UART dispatch, latency log |
| `backend/app/services/esp32_lib_manager.py`, `api/routes/simulation.py` | `esp32_chip_net` command path |
| `test/backend/unit/test_chip_nets.py` | 10 cases: bus semantics, then two real chips over LINE and ANT nets |
| `test/backend/unit/test_chip_uart_binding.py` | 3 cases on the KQ-130F WASM: the attach keeps the config and names no UART, the runtime has no `CHIP_UART` and takes no `uart_map`, the bytes reach the writer over the net |
| `frontend/src/__tests__/chipnets-esp32-members.test.ts` | 9 cases on the net description sent to the worker |
| `test/fixtures/chip-nets/` | SX1262 and KQ-130F models (MIT, Martin Thuku), sources and a standalone self test |

No `.wasm` is checked in: the pytest cases compile the sources through the
backend's `ChipCompileService` (`test/backend/unit/chip_fixtures.py`) and
skip where no wasi-sdk is installed.
