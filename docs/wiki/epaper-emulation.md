# ePaper / e-Ink emulation in Velxio

Velxio emulates GxEPD2-driven ePaper panels across **three controller
families** — Solomon Systech **SSD168x** (mono + B/W/Red), UltraChip
**UC8159c** (5.65" 7-colour ACeP) and UltraChip **UC8179 / GD7965** (7.5"
mono) — on AVR, RP2040 and ESP32 boards. One component, one Web Component,
parameterised by `panelKind`; the decoder is selected from the panel's
`controllerFamily`.

> Status: every gallery example renders correctly on the boards it fits on
> (B/W, B/W/Red, and 7-colour ACeP). See "Decoder internals" and the sections
> after it for the rotation / paging / tri-colour / BUSY details, and
> "Roadmap" for what's still deferred.
>
> **Read with a date in mind (2026-09, board-buses F8).** The panel is a sink
> of the per-board SPI fabric on every engine: `EPaperPart.ts` attaches it
> with `attachSpiDevice` and the same browser decoder paints it whether the
> CPU runs in the tab or in a backend worker (see
> [board-buses.md](./board-buses.md)). The worker-side twins this page used
> to name (`esp32_spi_slaves.py`, the `*EpaperSlave` classes, the
> `epaper_update` event) are gone: on the ESP32 and STM32 QEMU boards the
> worker relays the panel's bytes to the tab while its chip select is listed
> in the bus map's `sinks` entry and holds no panel model. The one difference
> on that lane is that the BUSY pulse reaches the guest a socket round trip
> after the worker relayed `0x20`, so a driver polling BUSY there may not
> wait (same picture, shorter wait). The `test/test_epaper/` golden Python
> decoder this page cites is not in the tree any more; the vectors live in
> `frontend/src/__tests__/ssd168x-decoder.test.ts`,
> `epaper-part-integration.test.ts` and `uc8179_vectors.json`.

## Supported panels

| `panelKind` (metadata id) | Size | Resolution | Palette | Controller IC | AVR Uno? | RP2040? | ESP32? |
|---|---|---|---|---|:---:|:---:|:---:|
| `epaper-1in54-bw`  | 1.54" | 200×200 | B/W   | SSD1681           | ✅ paged | ✅ | ✅ |
| `epaper-2in13-bw`  | 2.13" | 250×122 | B/W   | SSD1675A / IL3897 | ✅ paged | ✅ | ✅ |
| `epaper-2in13-bwr` | 2.13" | 250×122 | B/W/R | SSD1680 (3-colour)| ⚠️ tight | ✅ | ✅ |
| `epaper-2in9-bw`   | 2.9"  | 296×128 | B/W   | SSD1680           | ⚠️ tight | ✅ | ✅ |
| `epaper-2in9-bwr`  | 2.9"  | 296×128 | B/W/R | SSD1680 (3-colour)| ❌ flash | ✅ | ✅ |
| `epaper-4in2-bw`   | 4.2"  | 400×300 | B/W   | SSD1683 / UC8176  | ❌ flash | ✅ | ✅ |
| `epaper-7in5-bw`   | 7.5"  | 800×480 | B/W   | UC8179 / GD7965   | ❌       | ⚠️ tight | ✅ |
| `epaper-5in65-7c`  | 5.65" | 600×448 | **ACeP 7-colour** | **UC8159c** | ❌ flash | ⚠️ tight | ✅ |

Three of those panels use a **non-SSD168x controller** and have their own
decoder; `EPaperPart.ts` picks it from `cfg.controllerFamily` on every
engine:

| `controllerFamily` | Panels | Decoder |
|---|---|---|
| `ssd168x` | 1.54 / 2.13 / 2.9 / 4.2" (B/W + B/W/R) | `SSD168xDecoder.ts` |
| `uc8159c` | 5.65" ACeP 7-colour | `UC8159cDecoder.ts` |
| `uc8179`  | 7.5" 800×480 mono     | `Uc8179Decoder.ts`  |

> The 7.5" panel was originally mislabeled `controllerFamily: 'ssd168x'`
> and rendered **blank** — GxEPD2_750_T7 is a UC8179, whose 0x10/0x13 DTM
> stream the SSD168x decoder ignores. Setting it to `'uc8179'` + adding the
> decoder fixed it.

"AVR ⚠️ tight" means the GxEPD2 paged build fits but Adafruit_GFX font
selection matters; "❌" means the binary blows past 32 KB at any sane
config.

## Wiring (every panel — same pinout)

```
                ┌──────────────┐
                │   ePaper     │
                │              │
                │  GND  VCC   │  GND  → board GND
                │              │  VCC  → board 3V3
                │  SCK  SDI   │  SCK  → SPI clock (SCK)
                │              │  SDI  → SPI MOSI
                │   CS   DC   │  CS   → any digital
                │              │  DC   → any digital (LOW = command)
                │  RST BUSY   │  RST  → any digital (active LOW)
                │              │  BUSY → any digital (input — HIGH while refreshing)
                └──────────────┘
```

**Pin order in GxEPD2 constructors**: `(CS, DC, RST, BUSY)`. Use those
exact pin numbers in the sketch.

## How the emulator works

There is one rendering path (since board-buses F3/F4; the three engine
hooks this table used to list are gone): `EPaperPart.attachEvents()` joins
the board's SPI fabric with `attachSpiDevice`, keyed by the panel's CS, and
the decoder in `frontend/src/simulation/displays/` receives the bytes the
controller port delivers while the panel is selected. CS / DC / RST are
tracked through `pinManager.onPinChange`, on every engine.

| Where the CPU runs | How the bytes reach the decoder |
|---|---|
| In the tab (AVR, RP2040, RP2350, the ESP32 JS engines, the XIAO ARM boards) | the engine's controller port, one byte at a time, in the same call |
| In a backend worker (ESP32 and STM32 QEMU, the Raspberry Pi guest) | the worker relays them to the tab (`spi_batch`, framed by the CS and D/C edges), only while the panel's CS is listed in the bus map's `sinks` entry |

On every engine:

- **Latched RAM**: pixels written via `0x24 WRITE_BLACK_VRAM` and `0x26
  WRITE_RED_VRAM` only become visible after `0x20 MASTER_ACTIVATION`.
- **BUSY pin**: driven HIGH for `refreshMs` (default 50 ms) after every
  activation, then back LOW. Real hardware is 1–5 s; the default is
  shrunk for snappy testing. Bump it via the `refreshMs` property.
- **Auto-RAM-window** auto-increment honours
  `0x11 DATA_ENTRY_MODE` (default 0x03 = X+, Y+, X-first).

## Decoder internals (SSD168x)

The SSD168x decoder is implemented once,
`frontend/src/simulation/displays/SSD168xDecoder.ts`, and paints the panel
on every engine (the worker-side Python twin was retired in board-buses F8
once the QEMU lane fed the same decoder). `ssd168x-decoder.test.ts` replays
the byte streams that used to be shared with the Python golden reference
and asserts the framebuffers.

### Native-window compose, then rotate

GxEPD2 pre-rotates in software (Adafruit_GFX) and writes the controller's
**native** RAM. For a panel used in landscape via `setRotation(1)` the native
RAM is the **transpose** of the display (e.g. a 296×128 panel's controller RAM
is 128×296). The decoder therefore:

1. Sizes RAM to the **longer side both ways** so a transposed layout isn't
   truncated.
2. Composes in the **native active window** (the bytes the firmware actually
   wrote, set via `0x44`/`0x45`), then rotates to the display orientation —
   identity when native == display, the inverse of `setRotation(1)` when
   native == transpose. Orientation is detected by **byte width** (`nw_bytes
   == ceil(W/8)` vs `ceil(H/8)`), because a non-multiple-of-8 native width
   (the 2.13" panel is 122 px → padded to 128) breaks a naive pixel compare.

> Limitation: the stream looks identical for rotation 0 vs 2 and 1 vs 3, so the
> decoder can only disambiguate 0/1 (which every shipped example uses).

### Paged drivers → window union

GxEPD2 with `page height < panel` (`firstPage()`/`nextPage()`) writes the frame
in horizontal strips, **setting a partial RAM window per page**. Compose must
use the **union** of every window since the last flush (the `_win_*_set` flags
reset on `0x20`), or only the last strip renders — the all-white-paged-panel
bug (1.54" Uno, 4.2" Pico, 7.5" ESP32).

### RAM Y-counter wraps at the window

The RAM address counter **wraps at the active-window boundary** like real
hardware. `GxEPD2_3C` (tri-colour) writes the `0x24` plane then the `0x26`
plane **without re-seeking the counter** between them, relying on this wrap; a
decoder that runs Y past the window end drops every `0x26` byte and the red
layer goes white.

### B/W vs B/W/Red (`is_bwr`)

- **Tri-colour** (`palette: 'bwr'`): `0x26` is the additive **red** plane
  (red wins on compose, red RAM inits to 0x00 "no red").
- **B/W**: `0x26` is a *second mono plane* (some controllers, e.g. GDEY029T94,
  mirror the image there) — red RAM inits to 0xFF and a pixel is white only if
  **both** planes say white.

The browser passes `isBwr = cfg.palette === 'bwr'`; the worker derives it from
`panel_kind` containing `'bwr'`.

## UltraChip decoders (UC8159c / UC8179)

The UltraChip family is a different protocol from SSD168x: big register-setup
commands during init, then a linear **DTM** image stream and a `0x12` refresh
(the flush opcode, vs SSD168x's `0x20`).

| | **UC8159c** (5.65" ACeP) | **UC8179** (7.5" mono) |
|---|---|---|
| Pixels | 2 px/byte, 3-bit palette (7 colours) | 8 px/byte, 1 bpp (`0xFF` = white) |
| Image command | `0x10` DTM1 (linear, no window) | `0x13` DTM2 "current" (`0x10` = ignored "previous") |
| Window | none — flat native raster | `0x90` partial window (9 bytes, pixel coords MSB-first), framed by `0x91`/`0x92` |
| Rotation | none (writes native raster for any rotation) | none — data lands at absolute pixel coords in the window, so compose == RAM |
| Refresh / flush | `0x12` | `0x12` |

Both produce a `Frame` the existing `paintFrame()` renders (the UC8179 reuses
the SSD168x 0=black / 1=white palette; the UC8159c uses `ACEP_PALETTE_RGB`).

## BUSY polarity is per controller family

GxEPD2 busy-waits **inside `_PowerOn()`/`_InitDisplay()`, before any frame is
sent**, so the worker seeds the BUSY pin to the panel's *idle* level at
registration (`esp32_worker.py`, the `_init_sensors` path):

| Family | Idle level | Busy level |
|---|:---:|:---:|
| SSD168x | **LOW** | HIGH |
| UltraChip (uc8159c, uc8179) | **HIGH** | LOW |

Get this wrong and GxEPD2's first busy-wait never satisfies → a **10 s "Busy
Timeout!"** on every refresh (the original 7.5" symptom). The panel is the
one writer of BUSY on every engine: it seeds the idle level when it attaches
and pulses the busy level for `refreshMs` after `0x20`; on the QEMU lane the
seed and the pulse travel to the guest through the bridge's pin injection,
so a driver that polls BUSY right after the refresh command may see it
before the pulse lands (the wait is shorter, the picture is the same).

## WS plumbing (QEMU lane)

The worker sends no `epaper_update` any more. The bytes come as `spi_batch`
events framed by the CS and D/C edges around them, the same shape every
other tab-side sink receives (see [board-buses.md](./board-buses.md),
"Sinks stay in the tab"), and `EPaperPart` decodes them through its
`RemoteSpiPort` exactly as it decodes an in-tab engine's bytes.

## Library compatibility matrix

| Library | AVR | RP2040 | ESP32 | Notes |
|---|:---:|:---:|:---:|---|
| **GxEPD2** (Jean-Marc Zingg) | ✅ (panel must fit flash) | ✅ | ✅ | The de-facto Arduino library; every example is GxEPD2 (BW / 3C / 7C). |
| **Adafruit_EPD** | ❌ RAM | ✅ | ✅ | Should work — the SSD168x command set is identical. |
| **ESPHome `waveshare_epaper`** | n/a | n/a | ✅ | Generates the same SPI traffic as Adafruit_EPD; tested on real hardware. |

The example sketches use GxEPD2. Both `GxEPD2` and `Adafruit GFX
Library` are auto-installed by the editor when you load any example
that lists them in `libraries: [...]`.

## Try it

1. Open `/examples` and pick **ePaper 1.54" Hello — Arduino Uno**.
2. Hit **Run**. After ~1 s the panel "refreshes" (you'll see the BUSY
   shimmer overlay) and the 1.54" canvas shows "Velxio / ePaper / OK!"
   in black on the off-white paper background.
3. Try the **2.9" ESP32 Weather** example next. With the in-browser ESP32
   engine the path is the same as the Uno's; with `?esp32sim=qemu` the CPU
   runs in the backend worker and the bytes reach the same decoder over
   the WebSocket (`spi_batch`). Same UX from the user's POV.

## Debugging gotchas

- **ESP32 ePaper render is SLOW.** It's a per-byte SPI stream; the 7.5"
  800×480 pushes ~96 KB/refresh and takes a while. `display.init(..., true,
  ...)` also does an early **clear-to-white refresh first**, so the *first*
  flush is blank — reading the canvas/log too early looks like "it renders
  white". Wait for the image flush (the panel actually changing, or the
  sketch's `Serial.println("frame done")`).
- **Restart the backend between ESP32 sims.** The lcgamboa QEMU keeps
  singleton SPI state; a second Run in the same backend can corrupt it. For a
  clean measurement: restart backend → reload page → Run once.
- **`controllerFamily` must match the GxEPD2 driver class.** A UC8179 /
  UC8159c panel decoded as `ssd168x` (or vice-versa) renders blank — the
  command sets don't overlap.
- **Tests** (must stay green): `cd frontend && npx vitest run
  src/__tests__/ssd168x-decoder.test.ts` (15) and `pytest test/test_epaper`
  (23). Tri-colour cases construct the decoder with `palette: 'bwr'` /
  `is_bwr=True`.

## Roadmap (deferred)

| Feature | Why not yet |
|---|---|
| ~~Tri-colour SSD168x (B/W/R)~~ | **shipped**: `epaper-2in13-bwr`, `epaper-2in9-bwr` panel kinds. The decoder's red RAM plane (`0x26 WRITE_RED_VRAM`) was always there; we just enabled it for the SSD1680 3-colour panels. |
| ~~UC8159c 5.65" 7-colour ACeP~~ | **shipped**: `epaper-5in65-7c` panel kind. New decoder family, same hook + Web Component. |
| ~~UC8179 7.5" full driver~~ | **shipped**: `epaper-7in5-bw` now uses the dedicated `Uc8179Decoder` (controllerFamily `uc8179`) instead of being mis-decoded as SSD168x. |
| Other UC81xx panels (UC8176 4.2" alt) | The SSD168x driver covers the 4.2" GxEPD2_420 path today (it emits SSD168x-compatible traffic). Only matters if someone picks a panel whose GxEPD2 class strictly emits UC81xx commands a current decoder doesn't model. |
| **E Ink Spectra 6 13.3" 1200×1600** (Seeed [6569](https://www.seeedstudio.com/13-3inch-Six-Color-eInk-ePaper-Display-with-1200x1600-Pixels-p-6569.html)) | Reverse-engineered command set; ship after Phase 1 proves the scaffold and we can capture real SPI traces from a Seeed EE02. |
| IT8951 Carta panels | Different protocol entirely (SPI packet stream). |
| LUT (`0x32`) waveform validation | Accept silently; never validate. Real panels sometimes send vendor-specific LUTs that aren't worth fingerprinting. |
| Real-time partial-window refresh | Phase 1 always does a full-frame refresh. |
| MicroPython on Pi Pico W | Phase 2.5 — no current `epaper` MicroPython driver tested in Velxio. |

## Code map

| File | Purpose |
|---|---|
| `frontend/src/simulation/displays/SSD168xDecoder.ts` | SSD168x browser decoder (TS port of the golden spec) |
| `frontend/src/simulation/displays/UC8159cDecoder.ts` | UC8159c (5.65" ACeP 7-colour) browser decoder |
| `frontend/src/simulation/displays/Uc8179Decoder.ts` | UC8179 (7.5" mono) browser decoder |
| `frontend/src/simulation/displays/EPaperPanels.ts`   | Per-panel geometry + `controllerFamily` assignments |
| `frontend/src/components/velxio-components/EPaperElement.ts` | `<velxio-epaper>` Web Component |
| `frontend/src/components/velxio-components/EPaper.tsx` | Thin React wrapper |
| `frontend/src/simulation/parts/EPaperPart.ts` | `attachEvents` factory — branches AVR / RP2040 / ESP32 + picks the decoder by `controllerFamily` |
| `frontend/src/data/examples-displays-epaper.ts` | gallery examples |
| `frontend/public/components-metadata.json` | picker entries (category: `displays`) |
| `backend/app/services/esp32_worker.py` | relays the panel's SPI bytes to the tab (`spi_batch`) while its chip select is listed in the bus map's `sinks` entry; holds no panel model (the `esp32_spi_slaves.py` twins were retired in board-buses F8) |
| `test/test_epaper/ssd168x_decoder.py` | Golden Python SSD168x decoder (the spec) |
| `test/test_epaper/test_ssd168x_protocol.py` | pure-Python protocol tests |
| `frontend/src/__tests__/ssd168x-decoder.test.ts` | Vitest port of the same tests |
| `test/test_epaper/sketches/` | canonical "hello world" sketches |

## See also

- [Research dossier](../../test/test_epaper/autosearch/) — the
  pre-implementation research notes covering Seeed catalog,
  controllers, SPI protocol, library compatibility, SVG layouts, and
  the phased plan.
- [Custom chips (ESP32 backend runtime)](./custom-chips-esp32-backend-runtime.md)
  — the same backend-runs-the-peripheral pattern that the ePaper SSD168x
  slave mirrors.
