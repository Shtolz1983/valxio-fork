// MCP tool catalogue exposed to `claude -p`.
//
// `where: 'browser'` tools are forwarded over the WebSocket to the open IDE
// tab and executed against the Zustand stores there (frontend/src/ai/tools.ts
// implements them under the same names). `where: 'bridge'` tools run here.
import { z } from 'zod';

const pinRef = z
  .string()
  .describe('Pin reference "<partId>:<pinName>", e.g. "esp32:D4" or "dht1:SDA". Use exact pin names from get_pins.');

export const TOOLS = [
  {
    name: 'get_project',
    where: 'browser',
    description:
      'Current workspace: boards (id, kind), components (id, type, position, properties), wires (id, from, to) and code files per board. Call this first. A long file comes back cut short (its "truncated" says so): read it with read_file.',
    input: {},
  },
  {
    name: 'list_part_types',
    where: 'browser',
    description:
      'Search the component catalogue (sensors, displays, LEDs, buttons, motors...) and board kinds. Returns type ids to use with add_component / add_board.',
    input: {
      query: z.string().optional().describe('Free-text filter, e.g. "temperature", "oled", "dht". Omit to list categories.'),
    },
  },
  {
    name: 'get_pins',
    where: 'browser',
    description:
      'Exact pin names of a component type or board kind (or of an existing part id), plus datasheet facts: each pin\'s role, supply range, I2C addresses, libraries and notes for parts; input-only / strapping / ADC pins and default I2C/SPI pins for boards.',
    input: {
      type: z.string().describe('Component type id, board kind, or an existing part id.'),
    },
  },
  {
    name: 'add_board',
    where: 'browser',
    description: 'Place a microcontroller board on the canvas. Returns its id.',
    input: {
      kind: z.string().describe('Board kind from list_part_types, e.g. "arduino-uno", "esp32".'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  {
    name: 'add_component',
    where: 'browser',
    description: 'Place a component on the canvas. Returns its id.',
    input: {
      type: z.string().describe('Component type id from list_part_types.'),
      x: z.number().optional().describe('Canvas x in px. Boards sit around x=0..400; put parts to the right.'),
      y: z.number().optional(),
      properties: z.record(z.string(), z.unknown()).optional().describe('Initial properties, e.g. {"color":"red"} for an LED.'),
    },
  },
  {
    name: 'update_component',
    where: 'browser',
    description: 'Change properties (or position) of an existing component.',
    input: {
      id: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  {
    name: 'remove_part',
    where: 'browser',
    description: 'Remove a component or board (and its wires) by id.',
    input: { id: z.string() },
  },
  {
    name: 'connect',
    where: 'browser',
    description: 'Draw a wire between two pins. Returns the wire id.',
    input: {
      from: pinRef,
      to: pinRef,
      color: z.string().optional().describe('Wire color, e.g. "red" for power, "black" for GND.'),
    },
  },
  {
    name: 'disconnect',
    where: 'browser',
    description: 'Remove a wire by id.',
    input: { wireId: z.string() },
  },
  {
    name: 'read_file',
    where: 'browser',
    description:
      'Read a code file of a board in full (up to 1500 lines per call; "more" says where to continue). Read a file whole before changing it.',
    input: {
      boardId: z.string().optional().describe('Defaults to the active board.'),
      name: z.string().describe('File name, e.g. "sketch.ino".'),
      startLine: z.number().int().optional().describe('First line to return, 1-based (default 1).'),
      maxLines: z.number().int().optional(),
    },
  },
  {
    name: 'edit_file',
    where: 'browser',
    description:
      'Change part of an existing file: replace oldText (exact, as read_file shows it, unique in the file unless replaceAll) with newText. Prefer this to write_file for changes to existing code.',
    input: {
      boardId: z.string().optional().describe('Defaults to the active board.'),
      name: z.string(),
      oldText: z.string(),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
    },
  },
  {
    name: 'write_file',
    where: 'browser',
    description: 'Create a code file of a board, or replace one whole (the main sketch is "sketch.ino"). To change existing code use edit_file.',
    input: {
      boardId: z.string().optional().describe('Defaults to the active board.'),
      name: z.string(),
      content: z.string(),
    },
  },
  {
    name: 'set_libraries',
    where: 'browser',
    description:
      'Declare the Arduino libraries the board sketch needs (written to libraries.json and installed before compile). Use Arduino Library Manager names, e.g. "DHT sensor library".',
    input: {
      boardId: z.string().optional(),
      libraries: z.array(z.string()),
    },
  },
  {
    name: 'validate_circuit',
    where: 'browser',
    description:
      'Check the wiring the way the Run button does: electrical faults (shorts, missing power, LED without resistor) and pin-level mistakes (output on an input-only pin, I2C address clash, 5 V signal into a 3.3 V board, unwired required pins). Returns errors and warnings.',
    input: {},
    timeoutMs: 90_000,
  },
  {
    name: 'compile',
    where: 'browser',
    description: 'Compile the code of a board. Returns success and the compiler errors. ESP32 builds can take a few minutes the first time.',
    input: { boardId: z.string().optional() },
    timeoutMs: 8 * 60_000,
  },
  {
    name: 'run_simulation',
    where: 'browser',
    description: 'Compile if needed and start the simulation of all boards.',
    input: {},
    timeoutMs: 8 * 60_000,
  },
  {
    name: 'stop_simulation',
    where: 'browser',
    description: 'Stop the running simulation.',
    input: {},
  },
  {
    name: 'read_serial',
    where: 'browser',
    description: 'Wait, then return the Serial Monitor output of a board (the tail of it).',
    input: {
      boardId: z.string().optional(),
      waitMs: z.number().int().min(0).max(30_000).optional().describe('How long to wait before reading. Default 3000.'),
      maxChars: z.number().int().min(100).max(20_000).optional().describe('Default 4000.'),
    },
    timeoutMs: 40_000,
  },
  {
    name: 'inspect_part',
    where: 'browser',
    description:
      'What a part shows right now while the simulation runs: a display\'s screen as ASCII art ("#" = lit), an LED\'s value/brightness, a servo angle. Use it to check displays and outputs.',
    input: { id: z.string().describe('Component id from get_project.') },
  },
  {
    name: 'install_library',
    where: 'bridge',
    description: 'Install an Arduino library on the build server right away (set_libraries also does this at compile time).',
    input: { name: z.string(), version: z.string().optional() },
    timeoutMs: 3 * 60_000,
  },
  {
    name: 'list_enclosure_boards',
    where: 'bridge',
    description:
      'Boards a 3D-printable enclosure can be made for — id, the canvas board kinds each fits (canvasKinds), PCB size, mounting and connectors (side and position) — the battery packs a compartment can hold (id, size in mm), and the modules that can go inside the case (id, the canvas part types each is, size, height). Pick the board whose canvasKinds holds the kind of the board on the canvas; prototype boards (perfboard_*) are for circuits the user solders by hand.',
    input: {},
  },
  {
    name: 'get_enclosure',
    where: 'browser',
    description:
      'The enclosure of this project as it is now: the full spec (with the user\'s own edits from the enclosure dialog), its check results, the outer size, the connector windows and `faces` — where an opening can go on each wall (along, z) and on the lid and bottom (x, y). Call it before changing an existing case.',
    input: {},
  },
  {
    name: 'build_enclosure',
    where: 'bridge',
    description:
      'Build a 3D-printable case (base + lid) for a board and check it: collisions with the board, connector windows, wall thickness, supports, bed size, overhangs. Returns ok, the violations (fix every error and build again), the outer size, the plastic weight and `faces` (where openings can go), plus a render with 8 views to look at. The spec replaces the whole case: to change one thing, send the spec from get_enclosure with that one change. Millimetres, board coordinates (see the Enclosures section).',
    input: {
      board: z.string().describe('Enclosure board id from list_enclosure_boards, e.g. "arduino_uno".'),
      lid: z.enum(['screw', 'snap']).optional().describe('screw (default): M3 posts in the corners; snap: the lid clicks in.'),
      wall: z.number().optional().describe('Side wall thickness, default 2.'),
      floor: z.number().optional().describe('Floor thickness, default 2.'),
      lid_thickness: z.number().optional().describe('Default 2.'),
      clearance: z.number().optional().describe('Gap between the PCB edge and the inner wall, default 1.'),
      bottom_clearance: z.number().optional().describe('Space under the PCB; default from the board data.'),
      top_clearance: z.number().optional().describe('Gap between the tallest component and the lid, default 2.5. Raise it for parts plugged into headers.'),
      corner_radius: z.number().optional().describe('Default 3.'),
      connector_tolerance: z.number().optional().describe('Extra gap around each connector window, default 0.5.'),
      skip_connectors: z.array(z.string()).optional().describe('Connector names that get no window, e.g. ["power"] when the board is powered over USB.'),
      extras: z
        .array(
          z.object({
            name: z.string().optional().describe('Label on the render, e.g. "led" or "vents".'),
            face: z.enum(['left', 'right', 'front', 'back', 'top', 'bottom']),
            shape: z.enum(['circle', 'rect', 'slots']).optional().describe('Default circle. slots: a row of vent slots.'),
            center_x: z.number().optional().describe('top/bottom: centre X in board coordinates.'),
            center_y: z.number().optional().describe('top/bottom: centre Y in board coordinates.'),
            along: z.number().optional().describe('Side faces: centre along the side (Y for left/right, X for front/back).'),
            z: z.number().optional().describe('Side faces: centre height above the PCB top.'),
            diameter: z.number().optional().describe('circle'),
            width: z.number().optional().describe('rect/slots: along X (top/bottom) or along the side; one slot for slots.'),
            height: z.number().optional().describe('rect/slots: along Y (top/bottom) or Z (sides); one slot for slots.'),
            slot_count: z.number().int().optional().describe('slots: default 5.'),
            slot_pitch: z.number().optional().describe('slots: distance between slot centres, default 4.'),
          }),
        )
        .optional()
        .describe('Openings for the parts of the project (see the Enclosures section) and the ones the user asked for: LED and button holes, display windows, cable slots, vents.'),
      top_height: z.number().optional().describe('Tallest part above the PCB; default from the board data. Set it for a prototype board.'),
      battery: z.string().optional().describe('Battery compartment beside the board: a battery id from list_enclosure_boards, e.g. "2xAA" or "1x18650".'),
      battery_side: z.enum(['left', 'right']).optional().describe('End of the case the battery goes to, default right; never the side with connector windows.'),
      modules: z
        .array(
          z.object({
            name: z.string().describe('The part id on the canvas, e.g. "rtc1".'),
            type: z.string().optional().describe('Module id from list_enclosure_boards whose partTypes holds the part type.'),
            size: z.array(z.number()).length(2).optional().describe('PCB length and width in mm, for a part with no module entry.'),
            height: z.number().optional().describe('Tallest part above its PCB in mm; default from the module table, 10 for a module given by size.'),
            position: z.array(z.number()).length(2).optional().describe('PCB lower-left corner in board coordinates; omit to let the generator place it.'),
          }),
        )
        .optional()
        .describe('Modules that go inside the case, placed beside the board on supports; the case grows to hold them.'),
      lid_modules: z
        .array(
          z.object({
            name: z.string().describe('The part id on the canvas, e.g. "lcd1".'),
            type: z.string().describe('Module id from list_enclosure_boards marked underLid, e.g. "lcd1602".'),
            position: z.array(z.number()).length(2).optional().describe('PCB lower-left corner in board coordinates; omit to centre the displays on the lid.'),
          }),
        )
        .optional()
        .describe('Displays hung under the lid on posts, with a window cut over their visible area; the case rises to clear the parts below.'),
      bed: z.array(z.number()).length(3).optional().describe('Printer build volume X, Y, Z in mm, default [220, 220, 250].'),
    },
  },
];

export const DEFAULT_TIMEOUT_MS = 30_000;
