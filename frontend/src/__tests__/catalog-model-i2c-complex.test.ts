/**
 * The VL53L0X and MAX30102 catalog models under the card examples compiled
 * for the Uno (fixtures/catalog-<id>): the part attached the way the canvas
 * attaches a generic module (registerCardSimulations, then the registry's
 * attachEvents), on the ATmega's TWI through the bus fabric. What is asserted
 * is what the serial monitor shows, before and after the panel moves.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { registerCardSimulations } from '../partsCatalog/simulation';
import { Max30102Model, Vl53l0xModel, VL53L0X_OUT_OF_RANGE } from '../partsCatalog/models/i2cComplex';
import type { PartCard } from '../partsCatalog/types';
import { bareBoard, wireI2cPins, clearBench } from './helpers/i2cBench';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hexOf = (id: string) => readFileSync(path.join(FIXTURES, `catalog-${id}`, `${id}.ino.hex`), 'utf8');

const UNO = 'uno';
const UNO_SDA = 18;
const UNO_SCL = 19;
const CYCLES_PER_MS = 16_000;

const cleanups: Array<() => void> = [];

interface Bench {
  /** Run until `count` more lines match, or fail after `withinMs` of guest time. */
  lines(pattern: RegExp, count: number, withinMs?: number): string[];
  /** Run `ms` of guest time and return the lines printed meanwhile. */
  run(ms: number): string[];
}

function bench(id: string, componentId: string): Bench {
  const c = card(id);
  registerCardSimulations([c]);
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hexOf(id));
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard(UNO, 'arduino-uno', sim);
  wireI2cPins(componentId, { boardId: UNO, pin: UNO_SDA }, { boardId: UNO, pin: UNO_SCL });
  const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const cleanup = PartSimulationRegistry.get(c.id)!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    () => null,
    componentId,
  );
  if (typeof cleanup === 'function') cleanups.push(cleanup);

  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  const take = (): string[] => {
    const got: string[] = [];
    for (let nl = out.indexOf('\n', seen); nl >= 0; nl = out.indexOf('\n', seen)) {
      got.push(out.slice(seen, nl).trim());
      seen = nl + 1;
    }
    return got;
  };
  return {
    lines(pattern, count, withinMs = 3000) {
      const found: string[] = [];
      const limit = cycles() + withinMs * CYCLES_PER_MS;
      for (;;) {
        for (const line of take()) {
          if (pattern.test(line)) found.push(line);
          if (found.length === count) return found;
        }
        if (cycles() >= limit) {
          throw new Error(
            `${found.length} of ${count} lines matching ${pattern} in ${withinMs} ms of guest time; ` +
              `the sketch printed ${JSON.stringify(out.slice(-600))}`,
          );
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
    run(ms) {
      const limit = cycles() + ms * CYCLES_PER_MS;
      while (cycles() < limit) for (let i = 0; i < 20_000; i++) sim.step();
      return take();
    },
  };
}

afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  clearBench();
});

/** One register write, then a read of `n` bytes from `reg`, as the libraries do it. */
function readRegs(dev: Vl53l0xModel | Max30102Model, reg: number, n: number): number[] {
  dev.start(false);
  dev.writeByte(reg);
  dev.stop();
  dev.start(true);
  const out = Array.from({ length: n }, () => dev.readByte());
  dev.stop();
  return out;
}

function writeRegs(dev: Vl53l0xModel | Max30102Model, reg: number, ...bytes: number[]): void {
  dev.start(false);
  [reg, ...bytes].forEach((b) => dev.writeByte(b));
  dev.stop();
}

describe('VL53L0X model (Pololu VL53L0X)', () => {
  it('computes the timing budget the library computes after init (about 31 ms)', () => {
    const dev = new Vl53l0xModel(0x29);
    writeRegs(dev, 0x01, 0xe8);
    expect(dev.budgetUs()).toBe(31_230);
  });

  it('with no clock, a measurement is ready at the first poll', () => {
    const dev = new Vl53l0xModel(0x29);
    dev.values = { distance: 2150 };
    writeRegs(dev, 0x00, 0x02);
    expect(readRegs(dev, 0x13, 1)[0] & 0x07).not.toBe(0);
    const [hi, lo] = readRegs(dev, 0x1e, 2);
    expect((hi << 8) | lo).toBe(VL53L0X_OUT_OF_RANGE);
    writeRegs(dev, 0x0b, 0x01);
  });

  it('the card example prints the panel distance, then the new one and out of range', () => {
    const b = bench('vl53l0x', 'tof1');
    const first = b.lines(/^Distance: \d+ mm$/, 2, 3000);
    expect(first).toEqual(['Distance: 500 mm', 'Distance: 500 mm']);

    dispatchSensorUpdate('tof1', { distance: 1234 });
    b.lines(/^Distance: 1234 mm$/, 1, 400);
    // Above 2 m the library reports what a real module does without a target.
    dispatchSensorUpdate('tof1', { distance: 2200 });
    b.lines(new RegExp(`^Distance: ${VL53L0X_OUT_OF_RANGE} mm$`), 1, 400);
    expect(b.run(300).some((l) => /timeout|not found/.test(l))).toBe(false);
  }, 60_000);
});

describe('MAX30102 model (SparkFun MAX3010x)', () => {
  it('fills the FIFO at the configured rate: 9 bytes per sample with three slots', () => {
    const dev = new Max30102Model(0x57);
    dev.values = { bpm: 60, finger: 1 };
    let cycles = 0;
    dev.setClock({ now: () => cycles, clockHz: () => 16_000_000 } as never);
    expect(readRegs(dev, 0xff, 1)).toEqual([0x15]);
    writeRegs(dev, 0x08, 0x50); // 4x averaging, rollover
    writeRegs(dev, 0x0a, 0x2f); // 4096 nA, 400 Hz, 18 bit
    writeRegs(dev, 0x0c, 0x1f, 0x1f);
    writeRegs(dev, 0x11, 0x21, 0x03);
    writeRegs(dev, 0x09, 0x07);
    writeRegs(dev, 0x04, 0, 0, 0);
    cycles += 16_000 * 100; // 100 ms: 10 samples at 100 per second
    const [wr] = readRegs(dev, 0x04, 1);
    const [rd] = readRegs(dev, 0x06, 1);
    expect((wr - rd + 32) % 32).toBe(10);
    const bytes = readRegs(dev, 0x07, 9);
    const red = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) & 0x3ffff;
    const ir = ((bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) & 0x3ffff;
    expect(ir).toBeGreaterThan(99_000);
    expect(red).toBeGreaterThan(80_000);
    expect(readRegs(dev, 0x06, 1)[0]).toBe((rd + 1) % 32);
  });

  it('the card example prints about the panel bpm, then the no-finger line', () => {
    const b = bench('max30102', 'ppg1');
    // Four beats fill the average; the first ones after power-up settle the filter.
    b.run(5500);
    const lines = b.lines(/^IR: \d+/, 2, 1500);
    for (const line of lines) {
      const m = /^IR: (\d+) {2}BPM: (\d+)$/.exec(line);
      expect(m, line).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(50_000);
      expect(Math.abs(Number(m![2]) - 72)).toBeLessThanOrEqual(5);
    }

    dispatchSensorUpdate('ppg1', { bpm: 120 });
    b.run(4000);
    const faster = b.lines(/^IR: \d+/, 1, 1500)[0];
    const bpm = Number(/BPM: (\d+)$/.exec(faster)?.[1]);
    expect(Math.abs(bpm - 120), faster).toBeLessThanOrEqual(8);

    dispatchSensorUpdate('ppg1', { finger: 0 });
    b.run(600);
    const bare = b.lines(/^IR: \d+/, 1, 1500)[0];
    expect(bare).toMatch(/^IR: \d+ {2}\(no finger\)$/);
    expect(Number(/^IR: (\d+)/.exec(bare)![1])).toBeLessThan(50_000);
  }, 120_000);
});
