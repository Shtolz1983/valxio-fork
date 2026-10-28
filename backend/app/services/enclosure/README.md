# Enclosure generator

Deterministic generator of 3D-printable (FDM) enclosures for boards: `EnclosureSpec` -> base + lid,
checks, PNG render, STL/STEP. The AI assistant only chooses parameters; all geometry is built here.
Moved from the standalone `3D-model` prototype.

## Coordinates

Millimetres. Origin = lower-left corner of the PCB seen from above. X along the long edge, Y along the
short edge, Z up (Z=0 is the bottom of the floor in the built model).
Sides: `left` (X=0), `right` (X=length), `front` (Y=0), `back` (Y=width), `top` (lid), `bottom` (floor).
Side extras: `along` = center along the side axis (Y for left/right, X for front/back), `z` = center height
above the PCB top. Top/bottom extras: `center_x`, `center_y` in board coordinates.

## Modules

| module | role |
|--------|------|
| `spec.py` | pydantic models: `Board`, `Connector`, `ExtraCutout`, `EnclosureSpec` |
| `registry.py` | loads `boards/*.yaml`; user boards from `$ENCLOSURE_BOARDS_DIR` (opt-in) |
| `connectors.py` | connector body sizes by type (usb_b, usb_c, micro_usb, dc_jack, ...) |
| `modules/*.yaml` | the module table: breakouts that can go inside a case (board format plus `part_types`), and displays with a `window` that hang under the lid |
| `batteries.py` | battery pack sizes for the compartment (2xAA, 4xAA, 1x18650, 2x18650, 9V, lipo_503450) |
| `enclosure.py` | geometry: layout, base, lid, board ghost, keep-out volumes |
| `checks.py` | collisions, connector windows, wall thickness, supports, bed size, overhangs |
| `render.py` | 8-panel PNG with its own orthographic projection (matplotlib, no VTK) |
| `export.py` | STL (lid flipped for printing; base, lid and the battery hatch), STEP, spec.json |

## HTTP API

`backend/app/api/routes/enclosure.py`, mounted at `/api/enclosure`:

| route | returns |
|-------|---------|
| `GET /boards` | every board with size, mount and connectors; the battery packs; the module table |
| `POST /build` `{spec, render?, meshes?}` | `ok`, `violations`, `outer` box, `weight_g`, `connectors` (window size or null), base64 `render_png` and binary `base_stl` / `lid_stl` / `pcb_stl` / `connectors_stl` / `battery_stl` / `modules_stl` / `lid_modules_stl` in assembly position, `modules` and `lid_modules` (where each went) |
| `POST /export` `{spec, step?}` | zip with print files (lid flipped onto the bed); 422 with the errors if a check fails |

Unknown board: 404. Bad spec or unknown `skip_connectors`: 422. Jobs run one at a time (OpenCascade and pyplot
are not thread-safe).

## Boards

`arduino_uno` (4 x M3 standoffs), `arduino_nano`, `esp32_devkitc` and `esp32_devkit_v1` (supports under both short ends).
All have `verified: false`: nominal dimensions, not yet measured on a real board.
`perfboard_40x60` ... `perfboard_70x90`: hand-soldered prototype boards (M2 corner holes, no connectors); set
`top_height` in the spec to the tallest part soldered on.
`canvas_kinds` names the Velxio canvas boards (`BoardKind` in `frontend/src/types/board.ts`) a board fits; the
AI assistant picks the enclosure board by it.

## Battery compartment

`battery` puts a pocket for the pack at one end of the case (`battery_side`, never the side with connector windows):
the pack lies on the floor, low ribs hold it, a divider separates it from the board. The pack's long edge runs along
X or Y, whichever keeps the case smaller (with modules or displays, counting where they then go); the case grows deeper when the pack is wider than the board. It is changed
by opening the lid, or with `battery_hatch` through the floor: the floor under the pack opens (tapered 45 degrees, so
it prints without supports and the hatch cannot fall in) and a third printed part, `hatch`, fills it flush, held by
two M3 screws through its ears into bosses at both ends of the pocket (the pocket grows 8 mm at each end for them and
keeps the floor's thickness off the long walls). `check_hatch` checks the fit and the bosses.

## Modules inside

`modules` lists parts that go inside: a module table entry (`type`) or a bare `size` (+ `height`) for a part without one.
They go in rows behind the board, inside the board's compartment along X, on standoffs (modules with holes) or blocks
under both ends; a module too long for the compartment is turned 90 degrees, and if it still does not fit the case
grows towards an end with neither connector windows nor the battery. `position` pins a module by hand;
`check_modules` then reports overlaps with the board, its connectors, the battery or other modules. Module sizes are
nominal and assume header pins up with Dupont plugs on them.

## Displays under the lid

`lid_modules` hangs displays (module table entries with a `window`: OLED, LCD1602/2004, TM1637, MAX7219, ILI9341)
under the lid on posts that grow from it, display side up against the lid, with the window cut over the visible area.
They sit in a row across the middle of the lid unless pinned by `position`; the case grows when they do not fit inside
the lid's lip, and rises so that their back (header, I2C backpack, Dupont plugs) clears whatever lies right under them.
`check_lid_modules` reports a display under the lip, on another one, or hanging into the parts below.

## Rules

- Every new geometry feature needs a check that catches its failure mode and a test with a broken input.
- Tests: `pytest test/backend/unit/test_enclosure.py`.
