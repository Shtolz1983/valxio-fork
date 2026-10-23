# Custom Chips on ESP32 — backend WASM runtime architecture

> **Why this exists**: ESP32 in Velxio runs in a backend QEMU subprocess
> ([`backend/app/services/esp32_worker.py`](../../backend/app/services/esp32_worker.py)),
> not in the browser. QEMU's I2C callback (`picsimlab_i2c_event`) demands a
> **synchronous** byte response from the same thread. A WebSocket round-trip
> to a browser-side chip runtime cannot meet that timing — the firmware would
> always read the previous transaction's byte, breaking I2C semantics.
>
> Solution: load the user's chip `.wasm` **inside the same Python process as QEMU**
> using [wasmtime](https://wasmtime.dev/), so the chip's I2C callbacks run
> synchronously in the QEMU thread. Same fidelity as the hardcoded `MPU6050Slave` /
> `BMP280Slave` Python classes, but generic for any user-supplied chip.
>
> See also:
> [`docs/wiki/esp32-i2c-slave-simulation.md`](./esp32-i2c-slave-simulation.md) — the
> doc that established this pattern for hardcoded sensors;
> [`docs/wiki/custom-chips-chip-nets.md`](./custom-chips-chip-nets.md) — chip-to-chip
> nets, the cross-worker bridge and the UART binding.

---

## Table of contents

- [Architecture](#architecture)
- [Why not a frontend forwarder](#why-not-a-frontend-forwarder)
- [How it works step by step](#how-it-works-step-by-step)
- [Files](#files)
- [What's implemented vs deferred](#whats-implemented-vs-deferred)
- [How to extend it](#how-to-extend-it)

---

## Architecture

```
                          ┌────────────────────────────────────────────────────┐
  Browser (frontend)       │  CustomChipPart.attachEvents detects ESP32 sim    │
                          │  → calls sim.registerSensor('custom-chip', 0xFF,  │
                          │       { wasm_b64, attrs })                         │
                          │  → buffered into Esp32BridgeShim._pendingSensors  │
                          └────────────────────┬───────────────────────────────┘
                                               │  WebSocket: start_esp32 with
                                               │  sensors=[{sensor_type:'custom-chip',
                                               │            wasm_b64, ...}]
                                               ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  Backend uvicorn process                                                │
  │   simulation.py: forwards sensors to esp_lib_manager.start_instance()   │
  └────────────────────────────────┬───────────────────────────────────────┘
                                    │  spawns
                                    ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  esp32_worker.py subprocess (Python + wasmtime + libqemu-xtensa)       │
  │                                                                        │
  │   for s in initial_sensors:                                            │
  │       if s.sensor_type == 'custom-chip':                               │
  │           runtime = WasmChipRuntime(wasm_bytes, attrs, _emit)          │
  │           runtime.run_chip_setup()       ← chip declares pins+I2C addr │
  │           slave = WasmChipI2CSlave(runtime.i2c_address, runtime)       │
  │           _i2c_add(gpio, s, slave, runtime.i2c_addresses)              │
  │                                                                        │
  │   QEMU calls _on_i2c_event(addr, event)  [SYNC, in QEMU thread]        │
  │      → slave.handle_event(event)                                       │
  │      → runtime.call_i2c_callback('on_write', byte)                     │
  │      → wasmtime: chip's WASM code runs                                 │
  │      → returns byte                                                    │
  │      → QEMU continues firmware execution                               │
  │                                                                        │
  │   Latency: ~µs (a function call within the same process).              │
  └────────────────────────────────────────────────────────────────────────┘
```

There's no WebSocket round-trip on the I2C path. The chip's `on_write`,
`on_read`, `on_connect`, `on_stop` callbacks fire in the same nanosecond range
as a hand-written `MPU6050Slave.handle_event`. **Indistinguishable from real
hardware** to the firmware.

---

## Why not a frontend forwarder

The natural-looking design — "forward `i2c_event` over WS to the browser, run the
chip there, send back the response" — is **broken by the synchronous nature of
QEMU's I2C callback**. From the lcgamboa fork's `picsimlab_i2c.c`:

```c
// QEMU thread is blocked in this call until Python returns.
// For READ ops, the return value IS the byte sent to firmware.
int response = picsimlab_i2c_event_callback(bus_id, addr, event);
i2c_byte_to_firmware = response;  // immediate
```

A WebSocket round-trip takes **milliseconds** at best. QEMU finishes the I2C
read instruction in **nanoseconds**. By the time the browser's response arrives,
firmware is already five Wire transactions ahead. The first byte of every read
gets stale data; the second byte gets last frame's data; etc.

The hardcoded slaves (`MPU6050Slave`, `BMP280Slave`, …) work precisely because
they live in the QEMU thread. Our WASM slave does the same — we just delegate
the implementation to a user-provided binary instead of hand-writing it.

---

## How it works step by step

### 1. Frontend sends the chip alongside the firmware

`CustomChipPart.ts` detects an ESP32 simulator (`typeof simulator.registerSensor === 'function'`)
and instead of loading the WASM in the browser, calls:

```ts
simulator.registerSensor('custom-chip', /* virtualPin */ 0xFF, {
    wasm_b64: chipBase64,
    attrs:    chipAttrs,
});
```

`Esp32BridgeShim` buffers this into `_pendingSensors` and includes it in the
`start_esp32` WebSocket message:

```json
{
  "type": "start_esp32",
  "data": {
    "board": "esp32",
    "firmware_b64": "…",
    "sensors": [
      { "sensor_type": "custom-chip", "wasm_b64": "AGFzbQ…", "attrs": {} }
    ]
  }
}
```

### 2. Worker subprocess instantiates the WASM in-process

Inside `esp32_worker.py`, the existing sensor-registration loop gains a new branch:

```python
elif sensor_type == 'custom-chip':
    runtime = WasmChipRuntime(base64.b64decode(s['wasm_b64']),
                              s.get('attrs', {}), _emit)
    runtime.run_chip_setup()          # populates runtime.i2c_address and runtime.i2c_addresses
    if runtime.i2c_address is not None:
        # One slave for every address the chip attached: the table hands
        # each event the address it names.
        slave = WasmChipI2CSlave(runtime.i2c_address, runtime)
        _i2c_add(gpio, s, slave, runtime.i2c_addresses)
```

`_i2c_table` is an `I2cBusTable` (`backend/app/services/i2c_bus_table.py`,
board-buses F5): a registration is an identity, never an address, it holds
every address the chip attached, and it answers only on the controller the
tab's bus map (`bus_map.i2c`) says the chip's SDA is wired to (or, when the
map names a board pin, the one the live GPIO matrix routes there). Two chips
at one address on one controller both ACK and reads are their wired-AND, with
an `i2c-address-conflict` diagnostic, as on the bench.

`WasmChipRuntime` uses `wasmtime` to load the WASM with our host imports
(matching `velxio-chip.h`). Calling `run_chip_setup()` invokes the chip's
`chip_setup()` which:

- Calls `vx_pin_register` for each pin → handles allocated in Python state
- Calls `vx_i2c_attach(&cfg)` → host parses the 32-byte config struct from
  WASM memory and stores the address plus the four callback indices
  (function table indices for `on_connect`/`on_read`/`on_write`/`on_stop`);
  one `vx_i2c_attach` per address a chip answers

### 3. QEMU dispatches I2C events synchronously

When firmware does `Wire.beginTransmission(0x50)`, QEMU calls:

```python
# In _on_i2c_event (bus_id is the controller the guest clocked, I2C0 or I2C1):
found = _i2c_table.targets(bus_id, addr)             # the slaves on THAT controller at addr
return _i2c_table.event(bus_id, addr, event, found)  # SYNC: no thread hop, no WS
```

`WasmChipI2CSlave.handle_event` decodes the picsimlab op code:

```python
op   = event & 0xFF
data = (event >> 8) & 0xFF

if op == I2C_WRITE:
    return 0 if runtime.call_i2c_callback("on_write", data) else 1
if op == I2C_READ:
    return runtime.call_i2c_callback("on_read") & 0xFF
# … etc.
```

`runtime.call_i2c_callback` invokes the chip's WASM function via
`__indirect_function_table.get(idx)` and returns the result. The whole chain
is synchronous Python → wasmtime → C compiled to WASM.

### 4. Logs come back via WebSocket

`vx_log("hello")` and `printf("…")` from inside the chip emit `chip_log`
events through the `_emit` callback, which writes them to the worker's stdout
where the parent process reads them and forwards to the browser via the
existing telemetry WS channel. Async is fine here because logs aren't on the
firmware's critical path.

---

## Files

| File | Purpose |
|---|---|
| `backend/app/services/wasm_chip_runtime.py` | `WasmChipRuntime` — loads WASM, defines all `vx_*` host imports, WASI shim, I2C config parser |
| `backend/app/services/wasm_chip_slave.py` | `WasmChipI2CSlave` — implements the same `handle_event(event) -> int` contract as the hardcoded slaves |
| `backend/app/services/esp32_worker.py` | Hooked at `_init_sensors` to instantiate runtime + slave on `sensor_type == 'custom-chip'` |
| `frontend/src/simulation/parts/CustomChipPart.ts` | Detects ESP32 sim → calls `registerSensor('custom-chip', …)` instead of running WASM in the browser |
| `test/backend/unit/test_chip_nets.py`, `test_chip_uart_binding.py` | Unit tests (no QEMU): the chip net bus and the UART binding on two real chips compiled on demand (`chip_fixtures.py`) |
| velxio-prod checkout, `test/test_chip_backend_runtime/test_wasm_runtime.py` | Unit tests: GPIO / I2C / UART / SPI / pin_watch / timers in pure Python (pruned from OSS in `cd3fdded`) |
| velxio-prod checkout, `test/test_custom_chips_boards/test_esp32_chip_{i2c,uart,spi}.py` | E2E: ESP32 sketch ↔ chip over I2C (24C01), UART (ROT13), SPI (74HC595), with their sketches |

---

## What's implemented vs deferred

### Implemented

- ✅ All `vx_pin_*` digital APIs (read / write / register / set_mode)
- ✅ **`vx_pin_write` → real GPIO** via `qemu_picsimlab_set_pin(slot, value)` —
  chips like PCF8574 that drive output pins work natively. The frontend resolves
  each chip pin name → ESP32 GPIO (via the diagram's wires) and sends a
  `pin_map: {logical_name: gpio}` in the sensor payload.
- ✅ **`vx_pin_read` → live QEMU GPIO state** via the worker's `_pin_state`
  cache (updated from every `_on_pin_change` event).
- ✅ `vx_attr_register` / `vx_attr_read` (frontend pushes attrs into the sensor payload)
- `vx_i2c_attach` with the 4 callbacks: registers in the `I2cBusTable` by
  (controller, address), every address the chip attaches, on the controller
  its SDA is wired to
- **`vx_uart_attach` / `vx_uart_write`**: the chip is on the guest UART the
  worker's `uart_bus_table` resolves from the wiring (the live GPIO matrix
  of the pad its RX leg is on, else the tab's `bus_map.uart`); a chip on no
  controller hears nothing and is heard by nobody. There is no default unit,
  neither UART0 (the serial monitor) nor Serial1. Firmware writes on that
  UART trigger the chip's `on_rx_byte` synchronously via `_on_uart_tx`; the
  chip's `vx_uart_write` injects bytes back via `qemu_picsimlab_uart_receive`
  (acquiring the IO-thread lock). See
  [custom-chips-chip-nets.md](./custom-chips-chip-nets.md#uart-binding) and
  [board-buses.md](./board-buses.md).
- ✅ **Chip-to-chip nets** — a chip pin wired only to another chip's pin is
  carried by the worker's `ChipNetBus` (`nets` in the payload), and a net
  whose members live in two ESP32 workers is bridged through the frontend
  interconnect. Details, measured latency and limits in
  [custom-chips-chip-nets.md](./custom-chips-chip-nets.md).
- ✅ **`vx_spi_attach` / `vx_spi_start` / `vx_spi_stop`** — `_on_spi_event`
  routes byte exchanges to the chip synchronously. The buffer-based model
  matches the JS runtime's `SPIBus`. The re-arm pattern (chip calls
  `vx_spi_start` again from `on_done`) is supported. SPI shift registers and
  ADCs work.
- ✅ **`vx_timer_create` / `vx_timer_start` / `vx_timer_stop`** — a dedicated
  scheduler thread (`_chip_timer_thread`) wakes on the soonest deadline,
  acquires the QEMU IO-thread lock, and fires every due timer. The lock means
  a timer callback can safely call `vx_pin_write` etc. without races.
- ✅ **`vx_pin_watch` (firmware-driven, edge-triggered)** — chip subscribes
  to a pin via `vx_pin_watch(handle, edge, cb, ud)`. The worker's
  `_on_pin_change` dispatches to every runtime that has a watch on the
  triggered GPIO; `notify_pin_change` runs the chip callback synchronously
  inside the QEMU thread (lock held), so the callback can drive other GPIOs
  via `vx_pin_write` in the same critical section. Used by the 74HC595 to
  latch on RCLK rising edge.
- ✅ `vx_log` and `printf` via WASI `fd_write` → `chip_log` WS events
- ✅ `vx_sim_now_nanos` and the timers on the guest's virtual clock (`QEMU_CLOCK_VIRTUAL`; 0 at the chip's creation, the timer's deadline inside its callback)

### Deferred (clear extension paths)

| API | Path to add |
|---|---|
| `vx_pin_dac_write` → real ADC channel injection | Bridge to `qemu_picsimlab_set_apin`. ~30 min. |
| `vx_framebuffer_init` / `vx_buffer_write` | Forward pixel updates to the frontend canvas via WS event (async OK — display refresh is not synchronous). ~½ day. |
| ESP32-C3 (RISC-V) support | Same runtime, but the C3 worker uses `libqemu-riscv32.dll`. The runtime is architecture-neutral; just wire the same hooks in the C3 worker path. ~1 hour. |

The runtime stubs the remaining APIs with `_emit({type:'chip_warning'})` so
a chip that uses them won't crash — it just won't get the requested behavior
on ESP32.

---

## How to extend it

Every supported peripheral follows the same shape — pick the matching list
from the worker (`_i2c_table`, `_uart_table`, `_chip_spi_runtimes`,
`_chip_pin_watch_runtimes`, `_chip_timer_runtimes`), and the runtime exposes
a public dispatch method that the worker calls synchronously from the QEMU
thread. To add a new peripheral:

1. **Runtime side** (`wasm_chip_runtime.py`) — add the `vx_*` host imports in
   `_define_velxio` (parse any config struct from WASM memory), store the
   callback indices on `self`, and expose a public `feed_*` / `call_*` method
   that runs `self._call_indirect(idx, user_data, ...)`.
2. **Worker side** (`esp32_worker.py`) — register a global list (e.g.
   `_chip_xxx_runtimes`), append the runtime in the `custom-chip` branch of
   `_init_sensors` whenever its config is set, and dispatch from the relevant
   QEMU callback (`_on_*_event`). If the dispatch can call back into picsimlab
   (e.g. `vx_pin_write`), make sure the IO-thread lock is held — either you're
   already inside a QEMU callback (lock held), or you must acquire it with
   `_lock_iothread` (see `_chip_uart_writer` for the "only acquire if not
   already locked" pattern).
3. **Tests** — add a runtime unit test in
   `test/backend/unit/` (or, in the velxio-prod checkout,
   `test/test_chip_backend_runtime/test_wasm_runtime.py`) that exercises the
   chain in pure Python, then a `test_esp32_chip_*.py` E2E with a real Arduino
   sketch.

### Op-code reference (picsimlab encoding)

| Peripheral | Source | Encoding |
|---|---|---|
| GPIO write (firmware → host) | `pout_irq_handler` | `_on_pin_change(slot, level)` |
| GPIO direction change | `pdir_irq_handler` | `_on_dir_change(slot, dir)` |
| I2C event | `picsimlab_i2c.c` | `event = (data << 8) \| op`, op ∈ {`0x00=START_RECV`, `0x01=START_SEND`, `0x03=FINISH`, `0x05=WRITE`, `0x06=READ`} |
| SPI byte transfer | `picsimlab_spi.c::PICSIMLAB_SPI_transfer` | `event = data << 8` (op = `0x00`) |
| SPI CS line change | `spi_cs_irq_handler` | `event = ((((cs_idx & 3) << 1) \| level) << 8) \| 0x01` (op = `0x01`, ignored) |
| UART TX (firmware → host) | `_on_uart_tx_event` | `(uart_id, byte)` |
| UART RX (host → firmware) | `qemu_picsimlab_uart_receive(uart_id, buf, len)` | direct call, requires IO-thread lock |
| GPIO drive (host → firmware) | `qemu_picsimlab_set_pin(slot, value)` | `slot = gpio + 1`; lock not required (QEMU's IRQ raise/lower) |

Same pattern for every other API. The runtime is designed so each API is a
self-contained host-import block in `_define_velxio`.

---

## Verification

- **Unit tests in this repository** (no QEMU, no firmware): `pytest test/backend/unit/test_chip_*.py -v`
  → compiles the SX1262 and KQ-130F models and drives them over a net and a UART. **15/15 pass in ~2 s** where a wasi-sdk is installed (the Docker image).
- **Unit tests, velxio-prod checkout** (no QEMU, no firmware): `pytest test/test_chip_backend_runtime/ -v`
  → loads `eeprom-24c01.wasm` and `eeprom-24lc256.wasm` directly, drives I2C events,
  verifies state. **5/5 pass in ~0.3 s.**
- **E2E, velxio-prod checkout** (full QEMU + sketch): `pytest test/test_custom_chips_boards/test_esp32_chip_i2c.py`
  → compiles `eeprom-24c01.c` to WASM, compiles `esp32_eeprom_demo.ino` to firmware,
  boots them together, asserts the 4-byte round-trip. **1/1 passes in ~1.5 min.**
- **Sandbox regression**: `cd test/test_custom_chips && npm test` → **70/70 still pass**.
- **Frontend build**: `npm run build:docker` → clean.
