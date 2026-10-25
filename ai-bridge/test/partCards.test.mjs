import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardProblems, catalogSection, exampleFor, placeholders } from '../partCards.mjs';

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../parts-catalog');
const load = (id) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8'));

test('every card in parts-catalog passes the content check', () => {
  for (const file of readdirSync(CATALOG).filter((f) => f.endsWith('.json'))) {
    const card = JSON.parse(readFileSync(path.join(CATALOG, file), 'utf8'));
    assert.equal(`${card.id}.json`, file);
    assert.deepEqual(cardProblems(card), [], file);
  }
});

test('cardProblems catches what the compile check cannot', () => {
  const card = load('ds18b20');
  assert.match(cardProblems({ ...card, pins: card.pins.filter((p) => p.role !== 'ground') }).join(), /no ground pin/);
  assert.match(cardProblems({ ...card, example: card.example.replace('{{DQ}}', '{{DATA}}') }).join(), /\{\{DATA\}\} is not a pin/);
  assert.match(cardProblems({ ...card, example: card.example.replace('{{DQ}}', '{{VCC}}') }).join(), /power pin/);
  assert.match(cardProblems({ ...card, extra: 1 }).join(), /Unrecognized key|unrecognized/i);
  const i2c = load('bme280');
  assert.match(cardProblems({ ...i2c, i2c: undefined }).join(), /i2c\.addresses/);
});

test('exampleFor fills signal pins with free defaults per target', () => {
  const card = load('hc-sr04');
  assert.deepEqual(placeholders(card.example), ['TRIG', 'ECHO']);
  assert.match(exampleFor(card, 'uno'), /TRIG_PIN = 2;[\s\S]*ECHO_PIN = 3;/);
  assert.match(exampleFor(card, 'esp32'), /TRIG_PIN = 4;[\s\S]*ECHO_PIN = 16;/);
  const analog = load('soil-moisture');
  assert.match(exampleFor(analog, 'uno'), /SENSOR_PIN = A0;/);
  assert.match(exampleFor(analog, 'esp32'), /SENSOR_PIN = 34;/);
  const rfid = load('rc522');
  assert.match(exampleFor(rfid, 'uno'), /rfid\(10, 2\)/);
});

test('cardProblems checks the simulator section against the pins and controls', () => {
  const rain = load('rain-sensor');
  const sim = rain.sim;
  const out = (patch) => ({ ...rain, sim: { ...sim, outputs: [{ ...sim.outputs[0], ...patch }] } });
  assert.match(cardProblems(out({ from: 'wet' })).join(), /no control "wet"/);
  assert.match(cardProblems(out({ pin: 'DO' })).join(), /analog output needs an analog-in pin/);
  assert.match(cardProblems(out({ volts: [[0, 1], [1, 2]] })).join(), /exactly one of "volts" and "ratio"/);
  const sht = load('sht31');
  assert.match(cardProblems({ ...sht, sim: { ...sht.sim, controls: sht.sim.controls.slice(0, 1) } }).join(), /needs a control "humidity"/);
  assert.match(cardProblems({ ...rain, sim: { ...sim, model: 'no-such-chip' } }).join(), /sim\.model/);
});

test('the chat prompt lists every catalogue card with its part type and simulated values', () => {
  const cards = readdirSync(CATALOG).filter((f) => f.endsWith('.json')).map((f) => load(f.replace(/\.json$/, '')));
  const text = catalogSection(cards);
  for (const c of cards) assert.match(text, new RegExp(`^- ${c.component ?? c.id} — `, 'm'), c.id);
  assert.match(text, /^- bh1750 — BH1750: .*simulated values: lux 0\.\.20000 lx/m);
  assert.match(text, /^- tm1637 — .*shows what the sketch sends it/m);
  const draft = catalogSection([{ ...load('lm35'), status: 'draft' }]);
  assert.match(draft, /AI draft, not yet confirmed/);
});
