/**
 * The I2C models of models/i2cSimple.ts (ADXL345, INA219, MLX90614, QMC5883L,
 * CCS811) under the compiled example of their catalog card: the sketch runs
 * on avr8js, the part is registered and attached the way the canvas does it
 * (registerCardSimulations, then the card's part logic), and what is checked
 * is what the serial monitor shows, before and after the panel moves.
 *
 * Fixtures: fixtures/catalog-<id>/<id>.ino is the card's example as it was
 * compiled for the Uno (Arduino libraries of the card, backend arduino-cli).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { registerCardSimulations } from '../partsCatalog/simulation';
import {
  Adxl345Model,
  Ccs811Model,
  Ina219Model,
  Mlx90614Model,
  Qmc5883lModel,
  smbusPec,
} from '../partsCatalog/models/i2cSimple';
import type { GuestClock } from '../simulation/buses/types';
import type { I2CDevice } from '../simulation/I2CBusManager';
import type { PartCard } from '../partsCatalog/types';
import { bareBoard, clearBench, wireI2cPins } from './helpers/i2cBench';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hexOf = (id: string) => readFileSync(path.join(FIXTURES, `catalog-${id}`, `${id}.ino.hex`), 'utf8');

const UNO = 'uno';
const UNO_SDA = 18;
const UNO_SCL = 19;
const CYCLES_PER_MS = 16_000;

interface Bench {
  out(): string;
  /** Guest time since reset, in ms. */
  ms(): number;
  /** Run until the sketch has printed `count` more lines matching, or fail. */
  lines(pattern: RegExp, count: number, withinMs?: number): string[];
}

const cleanups: Array<() => void> = [];

/** The card's compiled example on an Uno, its module wired to A4/A5 as `componentId`. */
function bench(id: string, componentId = `${id}-1`): Bench {
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
  if (cleanup) cleanups.push(cleanup);

  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  return {
    out: () => out,
    ms: () => cycles() / CYCLES_PER_MS,
    lines(pattern, count, withinMs = 3000) {
      const found: string[] = [];
      const limit = cycles() + withinMs * CYCLES_PER_MS;
      for (;;) {
        for (let nl = out.indexOf('\n', seen); nl >= 0; nl = out.indexOf('\n', seen)) {
          const line = out.slice(seen, nl).trim();
          seen = nl + 1;
          if (pattern.test(line)) found.push(line);
          if (found.length === count) return found;
        }
        if (cycles() >= limit) {
          throw new Error(
            `${found.length} of ${count} lines matching ${pattern} in ${withinMs} ms of guest time; ` +
              `the sketch printed ${JSON.stringify(out)}`,
          );
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
  };
}

afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  clearBench();
});

/** One write phase, then (optionally) a repeated START and a read phase, as the fabric calls a target. */
function transact(dev: I2CDevice, write: number[], readLen = 0): number[] {
  dev.start?.(false);
  write.forEach((b) => dev.writeByte(b));
  if (readLen === 0) {
    dev.stop?.();
    return [];
  }
  dev.start?.(true);
  const bytes = Array.from({ length: readLen }, () => dev.readByte());
  dev.stop?.();
  return bytes;
}

describe('ADXL345 with Adafruit_ADXL345_Unified, compiled', () => {
  it('prints the panel acceleration in m/s^2 and follows the sliders', () => {
    const b = bench('adxl345');
    expect(b.lines(/^X: /, 1)).toEqual(['X: 0.00  Y: 0.00  Z: 9.81 m/s^2']);
    dispatchSensorUpdate('adxl345-1', { accelX: 0.5, accelY: -1, accelZ: 2 });
    expect(b.lines(/^X: /, 2).pop()).toBe('X: 4.90  Y: -9.81  Z: 19.61 m/s^2');
    expect(b.out()).not.toContain('not found');
  }, 120_000);

  it('saturates in 10-bit mode and left-justifies with JUSTIFY', () => {
    const dev = new Adxl345Model(0x53);
    dev.values = { accelX: 3, accelY: -0.5, accelZ: 1 };
    expect(transact(dev, [0x00], 1)).toEqual([0xe5]);
    transact(dev, [0x2d, 0x08]);
    // DATA_FORMAT 0: ±2 g, 10 bits, 4 mg per LSB.
    let d = transact(dev, [0x32], 6);
    const s16 = (lo: number, hi: number) => (((hi << 8) | lo) << 16) >> 16;
    expect([s16(d[0], d[1]), s16(d[2], d[3]), s16(d[4], d[5])]).toEqual([511, -125, 250]);
    // ±16 g, full resolution, left-justified: 13 bits at the top of 16.
    transact(dev, [0x31, 0x0f]);
    d = transact(dev, [0x32], 6);
    expect(s16(d[0], d[1])).toBe(750 << 3);
  });
});

describe('INA219 with Adafruit_INA219, compiled', () => {
  it('prints the panel bus voltage and current, and their product as power', () => {
    const b = bench('ina219');
    expect(b.lines(/^Bus: /, 1)).toEqual(['Bus: 5.00 V, current: 100.00 mA, power: 500.00 mW']);
    dispatchSensorUpdate('ina219-1', { busVoltage: 12, current: -250 });
    expect(b.lines(/^Bus: /, 2).pop()).toBe('Bus: 12.00 V, current: -250.00 mA, power: 3000.00 mW');
  }, 120_000);

  it('clips the shunt at the PGA range and reads no current before calibration', () => {
    const dev = new Ina219Model(0x40);
    dev.values = { busVoltage: 5, current: 1000 };
    const word = (reg: number) => {
      const [hi, lo] = transact(dev, [reg], 2);
      return (((hi << 8) | lo) << 16) >> 16;
    };
    expect(word(0x00)).toBe(0x399f);
    expect(word(0x04)).toBe(0);
    expect(word(0x01)).toBe(10000); // 100 mV in 10 µV
    // PGA /1: ±40 mV.
    transact(dev, [0x00, 0x01, 0x9f]);
    expect(word(0x01)).toBe(4000);
  });
});

describe('MLX90614 with Adafruit_MLX90614, compiled', () => {
  const parse = (line: string) => line.match(/^Ambient: (-?[\d.]+) C, object: (-?[\d.]+) C$/)!.slice(1).map(Number);

  it('prints the panel ambient and object temperatures, to the chip 0.02 K step', () => {
    const b = bench('mlx90614');
    const [ambient, object] = parse(b.lines(/^Ambient: /, 1)[0]);
    expect(Math.abs(ambient - 25)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(object - 36.5)).toBeLessThanOrEqual(0.02);
    dispatchSensorUpdate('mlx90614-1', { ambientTemp: -10, objectTemp: 250 });
    const [a2, o2] = parse(b.lines(/^Ambient: /, 2).pop()!);
    expect(Math.abs(a2 + 10)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(o2 - 250)).toBeLessThanOrEqual(0.02);
  }, 120_000);

  it('ends each word with the SMBus PEC and takes an EEPROM write only with a right one', () => {
    const dev = new Mlx90614Model(0x5a);
    dev.values = { ambientTemp: 25, objectTemp: 30 };
    const [lo, hi, pec] = transact(dev, [0x07], 3);
    expect(pec).toBe(smbusPec([0xb4, 0x07, 0xb5, lo, hi]));
    expect(((hi << 8) | lo) * 0.02 - 273.15).toBeCloseTo(30, 1);
    // Emissivity 0.5 with a wrong PEC: ignored; with the right one: taken.
    transact(dev, [0x24, 0xff, 0x7f, 0x00]);
    expect(transact(dev, [0x24], 2)).toEqual([0xff, 0xff]);
    transact(dev, [0x24, 0xff, 0x7f, smbusPec([0xb4, 0x24, 0xff, 0x7f])]);
    expect(transact(dev, [0x24], 2)).toEqual([0xff, 0x7f]);
  });
});

describe('QMC5883L with QMC5883LCompass, compiled', () => {
  it('prints the panel heading as the azimuth, above 180 in the library negative form', () => {
    const b = bench('qmc5883l');
    expect(b.lines(/^Azimuth: /, 1)).toEqual(['Azimuth: 0 deg']);
    dispatchSensorUpdate('qmc5883l-1', { heading: 90 });
    expect(b.lines(/^Azimuth: /, 2).pop()).toBe('Azimuth: 90 deg');
    dispatchSensorUpdate('qmc5883l-1', { heading: 270 });
    expect(b.lines(/^Azimuth: /, 2).pop()).toBe('Azimuth: -90 deg');
  }, 120_000);

  it('gives every heading a field the library truncates back to it', () => {
    for (const lsb of [3000, 12000]) {
      for (let h = 0; h < 360; h++) {
        const [x, y] = Qmc5883lModel.fieldFor(h, lsb);
        const azimuth = Math.trunc((Math.atan2(y, x) * 180) / Math.PI) % 360;
        expect(azimuth).toBe(h <= 180 ? h : h - 360);
      }
    }
  });
});

describe('CCS811 with Adafruit_CCS811, compiled', () => {
  it('starts the application, waits for a sample and prints the panel eCO2 and TVOC', () => {
    const b = bench('ccs811');
    expect(b.lines(/^eCO2: /, 1, 3000)).toEqual(['eCO2: 400 ppm, TVOC: 0 ppb']);
    // begin() waits 2 × 100 ms, then the first sample of drive mode 1 takes a second.
    expect(b.ms()).toBeGreaterThan(1200);
    dispatchSensorUpdate('ccs811-1', { eco2: 1200, tvoc: 250 });
    expect(b.lines(/^eCO2: /, 2, 3000).pop()).toBe('eCO2: 1200 ppm, TVOC: 250 ppb');
    expect(b.out()).not.toContain('not found');
  }, 180_000);

  it('has a sample one drive period after the mode is set, and flags what it does not have', () => {
    let now = 0;
    const clock: GuestClock = { now: () => now, clockHz: () => 16e6, scheduleEdge() {}, at: () => () => {} };
    const dev = new Ccs811Model(0x5a);
    dev.setClock(clock);
    dev.values = { eco2: 800, tvoc: 100 };
    expect(transact(dev, [0x20], 1)).toEqual([0x81]);
    expect(transact(dev, [0x00], 1)).toEqual([0x10]); // boot mode, app valid
    transact(dev, [0x02], 8); // no ALG_RESULT_DATA in boot mode
    expect(transact(dev, [0x00], 1)[0] & 0x01).toBe(1);
    expect(transact(dev, [0xe0], 1)).toEqual([0x02]); // READ_REG_INVALID, cleared by the read
    transact(dev, [0xf4]);
    transact(dev, [0x01, 0x10]); // drive mode 1: a sample a second
    expect(transact(dev, [0x00], 1)).toEqual([0x90]);
    now += 16e6;
    expect(transact(dev, [0x00], 1)).toEqual([0x98]);
    expect(transact(dev, [0x02], 8).slice(0, 4)).toEqual([800 >> 8, 800 & 0xff, 0, 100]);
    expect(transact(dev, [0x00], 1)).toEqual([0x90]);
    // Drive mode 5 does not exist.
    transact(dev, [0x01, 0x50]);
    expect(transact(dev, [0xe0], 1)).toEqual([0x04]);
    // Software reset: back to boot mode.
    transact(dev, [0xff, 0x11, 0xe5, 0x72, 0x8a]);
    expect(transact(dev, [0x00], 1)).toEqual([0x10]);
  });
});
