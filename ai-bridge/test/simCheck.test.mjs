import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyCard } from '../partCards.mjs';
import { boardProblems, lineShows, missingIn, numbersIn, parseHex, pickValues, tolerance } from '../simCheck.mjs';

const temperature = { key: 'temperature', label: 'Temperature', min: -55, max: 125, step: 0.5, unit: '°C', default: 25 };

test('pickValues: 30 % and 70 % of the range, on the step, away from the default', () => {
  assert.deepEqual(pickValues([temperature]), { A: { temperature: -1 }, B: { temperature: 71 } });
  // No float noise from the step.
  assert.deepEqual(pickValues([{ key: 'x', min: 0, max: 1, step: 0.1, default: 0.5 }]), { A: { x: 0.3 }, B: { x: 0.7 } });
  // A lands on the default: it moves one step.
  assert.deepEqual(pickValues([{ key: 'x', min: 0, max: 100, step: 1, default: 30 }]), { A: { x: 31 }, B: { x: 70 } });
  // A tiny range: still two distinct values, neither the default.
  const { A, B } = pickValues([{ key: 'x', min: 0, max: 2, step: 1, default: 1 }]);
  assert.notEqual(A.x, 1);
  assert.notEqual(B.x, 1);
  assert.notEqual(A.x, B.x);
  // Coarse steps snap.
  assert.deepEqual(pickValues([{ key: 'lux', min: 0, max: 65535, step: 10, default: 300 }]), { A: { lux: 19660 }, B: { lux: 45870 } });
});

test('numbersIn: signs and decimals, hex and ROM noise skipped', () => {
  assert.deepEqual(
    numbersIn('T:-1.25C rh 40% addr 0x48').map(({ n, d }) => [n, d]),
    [
      [-1.25, 2],
      [40, 0],
    ],
  );
  assert.deepEqual(numbersIn('Temperature = 25 C').map((x) => x.n), [25]);
  assert.deepEqual(numbersIn('no numbers here'), []);
});

test('number matching: print rounding, the step, 1.5 % of the range', () => {
  assert.ok(Math.abs(tolerance(temperature, 2) - 2.7) < 1e-9);
  assert.equal(tolerance({ min: 0, max: 1, step: 0.01 }, 0), 0.6);
  assert.equal(lineShows('Temperature: 71.00 C', temperature, 71), true);
  assert.equal(lineShows('Temperature: 73.50 C', temperature, 71), true);
  assert.equal(lineShows('Temperature: 74.00 C', temperature, 71), false);
  assert.equal(lineShows('Temperature: 142.00 C', temperature, 71), false);
  const rh = { key: 'humidity', min: 0, max: 100, step: 1 };
  const lines = ['T: -1.00 C', 'RH: 30 %'];
  assert.deepEqual(missingIn(lines, [temperature, rh], { temperature: -1, humidity: 30 }), []);
  assert.deepEqual(missingIn(lines, [temperature, rh], { temperature: -1, humidity: 70 }), ['humidity']);
});

test('parseHex: data records at their addresses, extended segments', () => {
  const flash = parseHex(':0400000001020304F2\n:020000021000EC\n:02000000AABB99\n:00000001FF\n', 0x20000);
  assert.deepEqual([...flash.slice(0, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...flash.slice(0x10000, 0x10002)], [0xaa, 0xbb]);
});

const lm75Card = (scale) => ({
  id: 'lm75-simcheck',
  name: 'LM75',
  title: 'LM75 digital temperature sensor (I2C)',
  group: 'climate',
  interface: 'i2c',
  pins: [
    { name: 'VCC', role: 'power' },
    { name: 'GND', role: 'ground' },
    { name: 'SDA', role: 'i2c-sda' },
    { name: 'SCL', role: 'i2c-scl' },
    { name: 'OS', role: 'nc' },
  ],
  supply: { min: 2.8, max: 5.5 },
  i2c: { addresses: ['0x48'] },
  libraries: ['I2C Temperature Sensors derived from the LM75'],
  // The object is made in setup(): the library divides floats in its
  // constructor, and a global one crashes the ESP32 at boot (see the
  // crash test below).
  example: `#include <Wire.h>
#include <Temperature_LM75_Derived.h>

Generic_LM75 *lm75;

void setup() {
  Serial.begin(115200);
  Wire.begin();
  lm75 = new Generic_LM75();
  Serial.println("LM75 ready");
}

void loop() {
  Serial.print("Temperature: ");
  Serial.print(lm75->readTemperatureC());
  Serial.println(" C");
  delay(500);
}
`,
  status: 'draft',
  sim: {
    model: 'regmap',
    controls: [temperature],
    regmap: {
      bus: 'i2c',
      width: 2,
      registers: { '0x01': '0x00', '0x02': ['0x4B', '0x00'], '0x03': ['0x50', '0x00'] },
      values: [{ reg: '0x00', from: 'temperature', bytes: 2, signed: true, scale, shift: 7 }],
    },
  },
});

test('boardProblems: a crash loop is the example, not the map', () => {
  const card = lm75Card(2);
  const crash = ['entry 0x40080574', "Guru Meditation Error: Core  0 panic'ed (Coprocessor exception). ", 'Rebooting...'];
  const [p] = boardProblems('ESP32', card, [{ lines: crash }], { temperature: -1 }, { temperature: 71 });
  assert.match(p, /crashes/);
  assert.match(p, /Coprocessor exception/);
  assert.match(p, /not sim\.regmap/);
});

test('boardProblems: a reading off by a factor, and an init that failed', () => {
  const card = lm75Card(4);
  const A = { temperature: -1 };
  const B = { temperature: 71 };
  const [p] = boardProblems('Arduino Nano', card, [{ lines: ['Temperature: -2.00 C'] }, { lines: ['Temperature: 142.00 C'] }], A, B);
  assert.match(p, /-2\.00 at -1 \(×2\), 142\.00 at 71 \(×2\)/);
  assert.match(p, /scale/);
  assert.match(p, /sim\.regmap\.values\[0\]/);
  const [q] = boardProblems('Arduino Nano', card, [{ lines: ['LM75 not found'] }, { lines: ['LM75 not found'] }], A, B);
  assert.match(q, /WHO_AM_I/);
  assert.match(q, /sim\.regmap\.registers/);
  assert.deepEqual(boardProblems('Arduino Nano', card, [{ lines: ['T: -1.00'] }, { lines: ['T: 71.00'] }], A, B), []);
});

// ── Against the running backend (compile + ESP32 worker) ──────────────────

const VELXIO = process.env.VELXIO_URL ?? 'http://localhost:3080';
const backendUp = await fetch(`${VELXIO}/api/parts-catalog/`, { signal: AbortSignal.timeout(2000) })
  .then(() => true)
  .catch(() => false);
const live = { skip: backendUp ? false : `backend not reachable at ${VELXIO}`, timeout: 20 * 60_000 };

/** Wall seconds a board's run took, from its step. */
function runSeconds(steps, board) {
  const s = steps.find((x) => x.startsWith(`simulation on ${board}: Serial follows`));
  return s ? Number(s.match(/\(([\d.]+) s\)$/)?.[1]) : NaN;
}

test('LM75 register map: Serial follows the panel on Nano and ESP32', live, async () => {
  const r = await verifyCard(lm75Card(2), { velxioUrl: VELXIO });
  assert.deepEqual(r.problems, []);
  assert.ok(r.steps.some((s) => /^simulation on Arduino Nano: Serial follows the panel, temperature -1 → 71/.test(s)), r.steps.join('\n'));
  assert.ok(r.steps.some((s) => /^simulation on ESP32: Serial follows the panel, temperature -1 → 71/.test(s)), r.steps.join('\n'));
  assert.ok(runSeconds(r.steps, 'Arduino Nano') < 30);
});

test('LM75 register map with a wrong scale: both boards say what is off', live, async () => {
  const r = await verifyCard(lm75Card(4), { velxioUrl: VELXIO });
  assert.equal(r.ok, false);
  for (const board of ['Arduino Nano', 'ESP32']) {
    const p = r.problems.find((x) => x.startsWith(`simulation on ${board}: Serial does not follow the panel`));
    assert.ok(p, `${board}: ${r.problems.join('\n')}`);
    assert.match(p, /"temperature" was set to -1 then 71/);
    assert.match(p, /-2\.00 at -1 \(×2\)/);
    assert.match(p, /scale/);
    assert.match(p, /\| Temperature: 127\.50 C/);
  }
});

test('a library that crashes the ESP32 at boot is reported as a crash', live, async () => {
  const card = lm75Card(2);
  card.example = card.example
    .replace('Generic_LM75 *lm75;', 'Generic_LM75 lm75;')
    .replace('  lm75 = new Generic_LM75();\n', '')
    .replace('lm75->', 'lm75.');
  const r = await verifyCard(card, { velxioUrl: VELXIO });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /simulation on ESP32: the sketch crashes[\s\S]*Coprocessor exception/);
  assert.ok(r.steps.some((s) => s.startsWith('simulation on Arduino Nano: Serial follows')), r.steps.join('\n'));
});

const max31855Card = (internalScale) => ({
  id: 'max31855-simcheck',
  name: 'MAX31855',
  title: 'MAX31855 thermocouple converter (SPI)',
  group: 'climate',
  interface: 'spi',
  pins: [
    { name: 'VCC', role: 'power' },
    { name: 'GND', role: 'ground' },
    { name: 'SCK', role: 'spi-sck' },
    { name: 'SO', role: 'spi-miso' },
    { name: 'CS', role: 'spi-cs' },
  ],
  supply: { min: 3, max: 3.6 },
  libraries: ['Adafruit MAX31855 library'],
  example: `#include <SPI.h>
#include <Adafruit_MAX31855.h>

Adafruit_MAX31855 tc({{CS}});

void setup() {
  Serial.begin(115200);
  if (!tc.begin()) {
    Serial.println("MAX31855 not found");
    while (1) delay(10);
  }
  Serial.println("MAX31855 ready");
}

void loop() {
  Serial.print("Thermocouple: ");
  Serial.print(tc.readCelsius());
  Serial.print(" C, internal: ");
  Serial.print(tc.readInternal());
  Serial.println(" C");
  delay(500);
}
`,
  status: 'draft',
  sim: {
    model: 'regmap',
    controls: [
      { key: 'temperature', label: 'Thermocouple', min: -200, max: 1350, step: 0.25, unit: '°C', default: 25 },
      { key: 'internal', label: 'Cold junction', min: -40, max: 125, step: 0.0625, unit: '°C', default: 25 },
    ],
    // A 32-bit word shifted out on every select: thermocouple 14 bits at 31..18, cold junction 12 bits at 15..4.
    regmap: {
      bus: 'spi',
      pointer: 0,
      values: [
        { reg: 0, from: 'temperature', bytes: 2, signed: true, scale: 4, shift: 2 },
        { reg: 2, from: 'internal', bytes: 2, signed: true, scale: internalScale, shift: 4 },
      ],
    },
  },
});

test('MAX31855 register map on SPI (CS D10 / GPIO5): passes, and a wrong scale fails', live, async () => {
  const ok = await verifyCard(max31855Card(16), { velxioUrl: VELXIO });
  assert.deepEqual(ok.problems, []);
  for (const board of ['Arduino Nano', 'ESP32']) {
    assert.ok(ok.steps.some((s) => s.startsWith(`simulation on ${board}: Serial follows the panel, temperature 265 → 885, internal 9.5 → 75.5`)), ok.steps.join('\n'));
  }
  const bad = await verifyCard(max31855Card(32), { velxioUrl: VELXIO });
  assert.equal(bad.problems.length, 2, bad.problems.join('\n'));
  for (const p of bad.problems) assert.match(p, /"internal" was set to 9\.5 then 75\.5 \(sim\.regmap\.values\[1\]\)/);
});
