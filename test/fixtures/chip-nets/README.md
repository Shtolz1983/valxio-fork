# Chip-nets fixture models

Two velxio custom chips (SX1262 and KQ-130F models by Martin Thuku), plus the functional
self test that drives them. They are here because they exercise the parts of
the ESP32 custom-chip runtime that nothing else in this repository does: a
pin wired only to another chip's pin, and a chip UART that is not UART0.

| Path | What it is |
|---|---|
| `../../../frontend/src/components/customChips/examples/sx1262.c`, `.chip.json` | SX1262 model: SPI slave plus a synthetic `ANT` pin (listed in the chip designer) |
| `../../../frontend/src/components/customChips/examples/kq130f.c`, `.chip.json` | KQ-130F model: 9600 8N1 UART plus a synthetic `LINE` pin (listed in the chip designer) |
| `chip_selftest.py` | 15 behavioural cases, run by hand inside a container |

Both models carry a Manchester-coded, self-clocked bit stream on the synthetic
pin: `ANT` is the air, `LINE` is the mains. Every chip wired to the same net
hears everything on it, collisions included, and a collision shows up as a
failed CRC rather than as anything cleverer.

No `.wasm` is checked in: velxio compiles chips itself. The pytest cases
compile `chip.c` through the backend's `ChipCompileService` (the same clang
the `POST /api/compile-chip/` route runs; see `test/backend/unit/chip_fixtures.py`)
and skip where no wasi-sdk is installed. The Docker image has one.

`chip_selftest.py` is not collected by pytest. It is the standalone harness the
models were developed against, kept here as the reference for what the chips
are supposed to do; `test/backend/unit/test_chip_nets.py` and
`test_chip_uart_binding.py` are the pytest cases. To run the self test against
a container:

    docker cp test/fixtures/chip-nets/chip_selftest.py velxio:/tmp/
    docker cp frontend/src/components/customChips/examples/sx1262.c velxio:/tmp/sx1262.c
    docker cp frontend/src/components/customChips/examples/kq130f.c velxio:/tmp/kq130f.c
    docker exec velxio sh -c 'for c in sx1262 kq130f; do /opt/wasi-sdk/bin/clang \
      --target=wasm32-unknown-wasip1 -O2 -nostartfiles -Wl,--import-memory \
      -Wl,--export-table -Wl,--no-entry -Wl,--export=chip_setup -Wl,--allow-undefined \
      -I /app/sdk /tmp/$c.c -o /tmp/$c.wasm; done'
    docker exec velxio python3 /tmp/chip_selftest.py

## Licence

These chip models and the self test are MIT, copyright Martin Thuku, and are
vendored here with that licence intact: see `LICENSE` in this directory. The
rest of velxio is AGPLv3 (or the commercial licence); MIT is compatible with
both, so nothing in this directory changes the terms the surrounding project
ships under.
