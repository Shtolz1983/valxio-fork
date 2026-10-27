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
| `enclosure.py` | geometry: layout, base, lid, board ghost, keep-out volumes |
| `checks.py` | collisions, connector windows, wall thickness, supports, bed size, overhangs |
| `render.py` | 8-panel PNG with its own orthographic projection (matplotlib, no VTK) |
| `export.py` | STL (lid flipped for printing), STEP, spec.json |

## HTTP API

`backend/app/api/routes/enclosure.py`, mounted at `/api/enclosure`:

| route | returns |
|-------|---------|
| `GET /boards` | every board with size, mount and connectors |
| `POST /build` `{spec, render?, meshes?}` | `ok`, `violations`, `outer` box, `weight_g`, base64 `render_png` and binary `base_stl` / `lid_stl` in assembly position |
| `POST /export` `{spec, step?}` | zip with print files (lid flipped onto the bed); 422 with the errors if a check fails |

Unknown board: 404. Bad spec or unknown `skip_connectors`: 422. Jobs run one at a time (OpenCascade and pyplot
are not thread-safe).

## Boards

`arduino_uno` (4 x M3 standoffs), `arduino_nano` and `esp32_devkitc` (supports under both short ends).
All have `verified: false`: nominal dimensions, not yet measured on a real board.
`canvas_kinds` names the Velxio canvas boards (`BoardKind` in `frontend/src/types/board.ts`) a board fits; the
AI assistant picks the enclosure board by it.

## Rules

- Every new geometry feature needs a check that catches its failure mode and a test with a broken input.
- Tests: `pytest test/backend/unit/test_enclosure.py`.
