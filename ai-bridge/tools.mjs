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
      'Current workspace: boards (id, kind), components (id, type, position, properties), wires (id, from, to) and code files per board. Call this first.',
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
    name: 'write_file',
    where: 'browser',
    description: 'Create or overwrite a code file of a board (the main sketch is "sketch.ino").',
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
];

export const DEFAULT_TIMEOUT_MS = 30_000;
