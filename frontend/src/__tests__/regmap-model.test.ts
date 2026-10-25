// @vitest-environment jsdom
/**
 * The `regmap` model in the tab (partsCatalog/models/regmap.ts) under real
 * firmware: two catalogue cards rewritten to describe their chip as a
 * register map instead of naming their hand-written model, running the
 * cards' compiled examples on an Uno. What the sketch prints must be what the
 * hand-written models make it print (catalog-model-i2c-simple / -spi tests).
 *
 *   - ADXL345 over I2C (Adafruit_ADXL345_Unified: DEVID check, POWER_CTL
 *     write, 16-bit little-endian axes at 4 mg per count);
 *   - MAX6675 bit-banged (no address phase: the word shifts out on select).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry, type AnySimulator } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { busRegistry, type NetResolver } from '../simulation/buses';
import { registerCardSimulations } from '../partsCatalog/simulation';
import type { PartCard } from '../partsCatalog/types';
import type { RegmapSpec } from '../partsCatalog/regmap';
import { bareBoard, clearBench, wireI2cPins } from './helpers/i2cBench';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const hexOf = (id: string) => readFileSync(path.join(FIXTURES, `catalog-${id}`, `${id}.ino.hex`), 'utf8');

/** Card `id` with its chip given as `regmap`, under a new id so both register. */
function regmapCard(id: string, regmap: RegmapSpec): PartCard {
  const c = JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
  return { ...c, id: `${id}-regmap`, sim: { ...c.sim!, model: 'regmap', regmap } };
}

/** Run `sim` until `pred` holds on the serial text, or the budget runs out. */
function serial(sim: AVRSimulator) {
  let text = '';
  sim.onSerialData = (ch: string) => {
    text += ch;
  };
  return {
    out: () => text,
    runUntil(pred: (out: string) => boolean, budget = 60_000_000) {
      for (let i = 0; i < budget; i++) {
        sim.step();
        if ((i & 0x3ff) === 0 && pred(text)) return;
      }
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  clearBench();
  busRegistry.clear();
});

describe('regmap model in the tab, compiled card examples on an Uno', () => {
  it('ADXL345 as a register map prints the panel acceleration and follows it', () => {
    const c = regmapCard('adxl345', {
      bus: 'i2c',
      registers: { '0x00': '0xE5' },
      values: [
        { reg: '0x32', from: 'accelX', bytes: 2, order: 'le', signed: true, scale: 250 },
        { reg: '0x34', from: 'accelY', bytes: 2, order: 'le', signed: true, scale: 250 },
        { reg: '0x36', from: 'accelZ', bytes: 2, order: 'le', signed: true, scale: 250 },
      ],
    });
    registerCardSimulations([c]);
    const sim = new AVRSimulator(new PinManager(), 'uno');
    sim.loadHex(hexOf('adxl345'));
    const s = serial(sim);
    bareBoard('uno', 'arduino-uno', sim);
    wireI2cPins('adxl-1', { boardId: 'uno', pin: 18 }, { boardId: 'uno', pin: 19 });
    const off = PartSimulationRegistry.get(c.id)!.attachEvents!(
      document.createElement('div'),
      sim as never,
      () => null,
      'adxl-1',
    );
    if (off) cleanups.push(off);

    s.runUntil((o) => /X: .*\n/.test(o));
    expect(s.out()).toContain('X: 0.00  Y: 0.00  Z: 9.81 m/s^2');
    dispatchSensorUpdate('adxl-1', { accelX: 0.5, accelY: -1, accelZ: 2 });
    s.runUntil((o) => o.includes('19.61 m/s^2'));
    expect(s.out()).toContain('X: 4.90  Y: -9.81  Z: 19.61 m/s^2');
    expect(s.out()).not.toContain('not found');
  }, 120_000);

  it('MAX6675 as a register map without an address phase, bit-banged', () => {
    const c = regmapCard('max6675', {
      bus: 'spi',
      pointer: 0,
      values: [{ reg: 0, from: 'temperature', bytes: 2, scale: 4, shift: 3 }],
    });
    registerCardSimulations([c]);
    const wiring: Record<string, number> = { SCK: 2, SO: 3, CS: 10 };
    const resolver: NetResolver = {
      resolve: (ref) =>
        ref.kind === 'board'
          ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
          : ref.componentId === 'tc-1' && wiring[ref.pinName] !== undefined
            ? { kind: 'board', boardId: 'uno-1', pin: wiring[ref.pinName] }
            : { kind: 'floating' },
      boardKind: () => 'arduino-uno',
      boards: () => ['uno-1'],
    };
    const sim = new AVRSimulator(new PinManager(), 'uno');
    sim.loadHex(hexOf('max6675'));
    busRegistry.setResolver(resolver);
    busRegistry.bindEngine('uno-1', sim.getBusBinding());
    const off = PartSimulationRegistry.get(c.id)!.attachEvents!(
      document.createElement('div'),
      sim as unknown as AnySimulator,
      (pin) => wiring[pin] ?? null,
      'tc-1',
    );
    if (off) cleanups.push(off);
    const s = serial(sim);

    s.runUntil((o) => /Thermocouple: [\d.]+ C\r?\n/.test(o));
    expect(s.out()).toContain('Thermocouple: 25.00 C');
    dispatchSensorUpdate('tc-1', { temperature: 432.75 });
    s.runUntil((o) => /432\.75 C\r?\n/.test(o));
    expect(s.out()).toContain('Thermocouple: 432.75 C');
  }, 120_000);
});
