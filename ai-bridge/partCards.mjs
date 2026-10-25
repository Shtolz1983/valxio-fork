// Sensor/module cards (parts-catalog/*.json): the schema, and the automatic
// check every card passes before it is stored — the libraries install and
// the example compiles for Uno and ESP32 against the Velxio backend.
// Used by the "+ Add sensor" job (server.mjs) and `npm run verify-cards`.
import { z } from 'zod';

import { regmapProblems } from '../frontend/src/partsCatalog/regmap.ts';
import { simCheck } from './simCheck.mjs';

export const PIN_ROLES = [
  'mcu-out', 'mcu-in', 'analog-in', 'bidir',
  'i2c-sda', 'i2c-scl', 'spi-sck', 'spi-mosi', 'spi-miso', 'spi-cs',
  'power', 'ground', 'passive', 'nc',
];
export const GROUPS = [
  'climate', 'light', 'distance', 'motion', 'air', 'water', 'electrical',
  'biometric', 'touch', 'rfid', 'sound', 'display', 'other',
];
export const INTERFACES = ['i2c', 'spi', '1-wire', 'single-wire', 'analog', 'digital', 'uart'];

/** Roles a sketch addresses by pin number — what {{PIN}} placeholders may name. */
const SIGNAL_ROLES = new Set(['mcu-out', 'mcu-in', 'analog-in', 'bidir', 'spi-cs']);

// Simulator models (frontend/src/partsCatalog/models) and the control keys each reads.
export const SIM_MODELS = {
  bh1750: ['lux'],
  aht20: ['temperature', 'humidity'],
  sht31: ['temperature', 'humidity'],
  adxl345: ['accelX', 'accelY', 'accelZ'],
  ina219: ['busVoltage', 'current'],
  mlx90614: ['objectTemp', 'ambientTemp'],
  qmc5883l: ['heading'],
  ccs811: ['eco2', 'tvoc'],
  bme280: ['temperature', 'humidity', 'pressure'],
  bmp180: ['temperature', 'pressure'],
  bme680: ['temperature', 'humidity', 'pressure', 'gas'],
  vl53l0x: ['distance'],
  max30102: ['bpm', 'finger'],
  max6675: ['temperature'],
  max31865: ['temperature'],
  rc522: ['card', 'tag'],
  dht11: ['temperature', 'humidity'],
  ds18b20: ['temperature'],
  tm1637: [],
  max7219: [],
  // The card's own register map (sim.regmap): its readings name the controls.
  regmap: [],
};

const curve = z.array(z.tuple([z.number(), z.number()])).min(2);
const SimSchema = z
  .object({
    model: z.enum(Object.keys(SIM_MODELS)).optional(),
    controls: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,23}$/),
            label: z.string().min(1).max(40),
            min: z.number(),
            max: z.number(),
            step: z.number().positive(),
            unit: z.string().max(8),
            default: z.number(),
          })
          .strict(),
      )
      .max(4),
    outputs: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ pin: z.string(), kind: z.literal('analog'), from: z.string(), volts: curve.optional(), ratio: curve.optional() }).strict(),
          z
            .object({
              pin: z.string(),
              kind: z.literal('digital'),
              from: z.string(),
              above: z.number().optional(),
              below: z.number().optional(),
              activeLow: z.boolean().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    // Checked by regmapProblems (frontend/src/partsCatalog/regmap.ts), the
    // engine's own rules, with messages that say what to fix.
    regmap: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{2}$/, 'I2C address like "0x76"');

export const CardSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'id: a-z, 0-9 and "-"'),
    name: z.string().min(1).max(24),
    title: z.string().min(1).max(160),
    titleRu: z.string().max(160).optional(),
    group: z.enum(GROUPS),
    interface: z.enum(INTERFACES),
    component: z.string().optional(),
    pins: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9+_-]{1,8}$/, 'pin name: up to 8 letters/digits as on the silkscreen'),
          role: z.enum(PIN_ROLES),
          desc: z.string().max(120).optional(),
        }),
      )
      .min(2)
      .max(16),
    supply: z.object({ min: z.number().positive(), max: z.number().positive() }),
    i2c: z.object({ addresses: z.array(hexAddress).min(1) }).optional(),
    pullups: z.array(z.object({ pin: z.string(), ohms: z.number().positive() })).optional(),
    libraries: z.array(z.string().min(1)).default([]),
    example: z.string().min(20),
    notes: z.array(z.string().max(300)).default([]),
    source: z.object({ datasheet: z.string().url().optional(), library: z.string().url().optional() }).default({}),
    status: z.enum(['verified', 'draft']),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    sim: SimSchema.optional(),
  })
  .strict();

/** Problems with a card's content, beyond the schema (empty = fine). */
export function cardProblems(card) {
  const parsed = CardSchema.safeParse(card);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || 'card'}: ${i.message}`);
  }
  const c = parsed.data;
  const problems = [];
  const names = c.pins.map((p) => p.name);
  if (new Set(names).size !== names.length) problems.push('pins: names must be unique');
  if (!c.pins.some((p) => p.role === 'ground')) problems.push('pins: no ground pin');
  if (!c.pins.some((p) => p.role === 'power')) problems.push('pins: no power pin');
  if (c.supply.min > c.supply.max) problems.push('supply: min is above max');
  if (c.interface === 'i2c') {
    if (!c.i2c) problems.push('i2c: an I2C part needs "i2c.addresses"');
    if (!c.pins.some((p) => p.role === 'i2c-sda') || !c.pins.some((p) => p.role === 'i2c-scl')) {
      problems.push('pins: an I2C part needs an i2c-sda and an i2c-scl pin');
    }
  }
  for (const p of c.pullups ?? []) {
    if (!names.includes(p.pin)) problems.push(`pullups: no pin "${p.pin}"`);
  }
  for (const ph of placeholders(c.example)) {
    const pin = c.pins.find((p) => p.name === ph);
    if (!pin) problems.push(`example: {{${ph}}} is not a pin of the card`);
    else if (!SIGNAL_ROLES.has(pin.role)) problems.push(`example: {{${ph}}} is a ${pin.role} pin — only signal pins take a placeholder`);
  }
  if (c.sim) problems.push(...simProblems(c));
  if (!/void\s+setup\s*\(/.test(c.example) || !/void\s+loop\s*\(/.test(c.example)) {
    problems.push('example: must be a complete sketch with setup() and loop()');
  }
  return problems;
}

function simProblems(c) {
  const problems = [];
  const keys = c.sim.controls.map((k) => k.key);
  for (const k of c.sim.controls) {
    if (k.min >= k.max) problems.push(`sim.controls.${k.key}: min must be below max`);
    if (k.default < k.min || k.default > k.max) problems.push(`sim.controls.${k.key}: default is outside min..max`);
  }
  if (c.sim.model === 'regmap') {
    problems.push(...regmapProblems(c.sim.regmap, keys));
    const bus = c.sim.regmap?.bus;
    if (bus === 'i2c' && c.interface !== 'i2c') problems.push('sim.regmap.bus: "i2c" needs an I2C card (interface "i2c")');
    if (bus === 'spi' && c.interface !== 'spi') problems.push('sim.regmap.bus: "spi" needs an SPI card (interface "spi")');
    if (!c.sim.controls.length) problems.push('sim: a register map needs at least one control');
  } else if (c.sim.regmap) {
    problems.push('sim.regmap: only with "model": "regmap"');
  }
  if (c.sim.model) {
    for (const k of SIM_MODELS[c.sim.model]) {
      if (!keys.includes(k)) problems.push(`sim.model: ${c.sim.model} needs a control "${k}"`);
    }
  }
  for (const out of c.sim.outputs ?? []) {
    const pin = c.pins.find((p) => p.name === out.pin);
    if (!keys.includes(out.from)) problems.push(`sim.outputs.${out.pin}: no control "${out.from}"`);
    if (!pin) problems.push(`sim.outputs: no pin "${out.pin}"`);
    else if (out.kind === 'analog' && pin.role !== 'analog-in') problems.push(`sim.outputs.${out.pin}: an analog output needs an analog-in pin`);
    else if (out.kind === 'digital' && pin.role !== 'mcu-in') problems.push(`sim.outputs.${out.pin}: a digital output needs an mcu-in pin`);
    if (out.kind === 'analog' && !out.volts === !out.ratio) problems.push(`sim.outputs.${out.pin}: give exactly one of "volts" and "ratio"`);
  }
  if (!c.sim.model && !(c.sim.outputs ?? []).length) problems.push('sim: needs a "model" or "outputs"');
  if (!c.sim.model && !c.sim.controls.length) problems.push('sim: needs at least one control');
  return problems;
}

export function placeholders(code) {
  return [...new Set([...code.matchAll(/\{\{([A-Za-z0-9+_-]+)\}\}/g)].map((m) => m[1]))];
}

export const TARGETS = {
  uno: { fqbn: 'arduino:avr:uno', digital: ['2', '3', '4', '5', '6', '7', '8', '9'], analog: ['A0', 'A1', 'A2', 'A3'], cs: '10' },
  esp32: { fqbn: 'esp32:esp32:esp32', digital: ['4', '16', '17', '25', '26', '27', '32', '33'], analog: ['34', '35', '36', '39'], cs: '5' },
};

/** The example with every {{PIN}} replaced by a free default pin of `target`. */
export function exampleFor(card, target) {
  const t = TARGETS[target];
  let digital = 0;
  let analog = 0;
  const pinOf = {};
  for (const ph of placeholders(card.example)) {
    const role = card.pins.find((p) => p.name === ph)?.role;
    pinOf[ph] = role === 'analog-in' ? t.analog[analog++] : role === 'spi-cs' ? t.cs : t.digital[digital++];
  }
  return card.example.replace(/\{\{([A-Za-z0-9+_-]+)\}\}/g, (_, name) => pinOf[name]);
}

async function postJson(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

function compileErrorText(body) {
  const text = [body.error, body.stderr].filter(Boolean).join('\n');
  // The first error lines say what is wrong; the rest is build noise.
  const lines = text
    .split('\n')
    .filter((l) => /: (fatal )?error:|undefined reference|was not declared|No such file or directory/.test(l))
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  return (lines.length ? lines.slice(0, 12).join('\n') : text.slice(-1500)).trim();
}

/**
 * The full check: schema and content, libraries install, example compiles for
 * every target, and for a register-map card the example runs in simulation
 * on a Nano and an ESP32 (simCheck.mjs). Resolves { ok, problems, steps } —
 * never throws for a bad card.
 */
export async function verifyCard(card, { velxioUrl, targets = ['uno', 'esp32'], log = () => {} } = {}) {
  const steps = [];
  const problems = cardProblems(card);
  if (problems.length) return { ok: false, problems, steps };
  const c = CardSchema.parse(card);

  for (const lib of c.libraries) {
    log(`install ${lib}`);
    const r = await postJson(`${velxioUrl}/api/libraries/install`, { name: lib }, 5 * 60_000).catch((e) => ({ ok: false, body: { error: e.message } }));
    if (!r.ok || !r.body.success) {
      problems.push(`library "${lib}": ${r.body.error || r.body.detail || `HTTP ${r.status}`} — use the exact Library Manager name`);
    } else {
      steps.push(`library ${lib}: installed`);
    }
  }
  if (problems.length) return { ok: false, problems, steps };

  // What each compile produced, for the simulation check.
  const firmware = {};
  for (const target of targets) {
    log(`compile for ${target}`);
    const t0 = Date.now();
    const r = await postJson(
      `${velxioUrl}/api/compile/`,
      {
        files: [{ name: 'sketch.ino', content: exampleFor(c, target) }],
        board_fqbn: TARGETS[target].fqbn,
        libraries: c.libraries,
        initiated_by: 'agent',
      },
      15 * 60_000,
    ).catch((e) => ({ ok: false, body: { error: e.message } }));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (r.ok && r.body.success) {
      steps.push(`example compiles for ${target} (${secs} s)`);
      firmware[target] = target === 'uno' ? r.body.hex_content : r.body.binary_content;
    } else {
      problems.push(`example does not compile for ${target}:\n${compileErrorText(r.body)}`);
    }
  }
  // A register map is the card's own model: run the example against it.
  if (!problems.length && c.sim?.model === 'regmap') {
    const sim = await simCheck(c, { velxioUrl, firmware, log });
    problems.push(...sim.problems);
    steps.push(...sim.steps);
  }
  return { ok: problems.length === 0, problems, steps };
}

/**
 * Models the ESP32's QEMU worker also has (backend/app/services/
 * catalog_i2c_models.py, esp32_onewire.py, and its own DHT11). Other chip
 * models answer only on boards simulated in the browser; analog and digital
 * outputs work on every board.
 */
export const ESP32_SIM_MODELS = ['bh1750', 'aht20', 'sht31', 'bme280', 'dht11', 'ds18b20', 'tm1637', 'max7219', 'vl53l0x', 'max30102', 'adxl345', 'ina219', 'mlx90614', 'qmc5883l', 'ccs811', 'bmp180', 'bme680', 'max6675', 'max31865', 'rc522', 'regmap'];

/**
 * The catalogue as a section of the chat assistant's system prompt, so it
 * knows which sensors exist without having to search: the part type it places
 * (the card's own part, or the generic module under the card id), the name,
 * what it is, and the values the simulator lets it set.
 */
export function catalogSection(cards) {
  const lines = cards
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const type = c.component ?? c.id;
      const where = c.sim?.model
        ? ESP32_SIM_MODELS.includes(c.sim.model)
          ? ', also on ESP32'
          : ', not on ESP32'
        : '';
      const sim = c.sim
        ? c.sim.controls.length
          ? `; simulated values: ${c.sim.controls.map((k) => `${k.key} ${k.min}..${k.max}${k.unit ? ` ${k.unit}` : ''}`).join(', ')}${where}`
          : `; shows what the sketch sends it${where}`
        : c.component
          ? ''
          : '; no simulated readings';
      const draft = c.status === 'draft' ? ' [AI draft, not yet confirmed by the user]' : '';
      return `- ${type} — ${c.name}: ${c.title} (${c.interface}${sim})${draft}`;
    });
  return (
    '\n\n## Sensors in the parts catalogue now\n\n' +
    'These modules are in the catalogue (part type — name: what it is). Place them with `add_component` ' +
    'using the part type, and call `get_pins` for their pins, supply, libraries and notes. When the user ' +
    'asks for one of these, use it; when they ask for a sensor that is not here, say so, propose the closest ' +
    'one from this list, and mention that "Sensors → Add sensor" can add it.\n\n' +
    lines.join('\n') +
    '\n'
  );
}
