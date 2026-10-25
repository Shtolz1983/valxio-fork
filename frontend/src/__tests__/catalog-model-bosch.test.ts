/**
 * The Bosch catalog models (partsCatalog/models/bosch.ts) under the cards'
 * own examples, compiled for the Uno with the cards' libraries (Adafruit
 * BME280, Adafruit BMP085, Adafruit BME680 with the bundled bme68x driver)
 * and run on avr8js. The part is attached the way the canvas attaches a
 * generic module: registerCardSimulations, then the registry's attachEvents
 * under the component id, its SDA/SCL wired to A4/A5.
 *
 * What is asserted is the serial monitor: the panel's defaults first, then
 * the values a slider move sends.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { registerCardSimulations } from '../partsCatalog/simulation';
import type { PartCard } from '../partsCatalog/types';
import {
  Bme280Model,
  Bme680Model,
  Bmp180Model,
  bme280Humidity,
  bme280Pressure,
  bme280TFine,
  bme680GasLow,
  bme680Humidity,
  bme680Pressure,
  bme680Temperature,
  bmp180Pressure,
  bmp180Tenths,
  invertMonotonic,
} from '../partsCatalog/models/bosch';
import { bareBoard, wireI2cPins, clearBench } from './helpers/i2cBench';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(HERE, '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hex = (id: string) => readFileSync(path.join(HERE, `fixtures/catalog-${id}/${id}.ino.hex`), 'utf8');

const UNO_SDA = 18;
const UNO_SCL = 19;
const CYCLES_PER_MS = 16_000;

interface Bench {
  out(): string;
  /** Run until `count` more lines match `pattern`, or fail after `withinMs` of guest time. */
  lines(pattern: RegExp, count: number, withinMs?: number): string[];
}

function bench(id: string): Bench {
  const c = card(id);
  registerCardSimulations([c]);
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex(id));
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  bareBoard('uno', 'arduino-uno', sim);
  wireI2cPins(id, { boardId: 'uno', pin: UNO_SDA }, { boardId: 'uno', pin: UNO_SCL });
  const el = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  const cleanup = PartSimulationRegistry.get(id)!.attachEvents!(
    el as unknown as HTMLElement,
    sim as never,
    () => null,
    id,
  );
  if (typeof cleanup === 'function') disposers.push(cleanup);

  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  return {
    out: () => out,
    lines(pattern, count, withinMs = 5000) {
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

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  clearBench();
});

describe('Bosch models: inverse compensation', () => {
  it('BME280 words decode to the panel values with the library arithmetic', () => {
    const dev = new Bme280Model(0x76);
    for (const [t, h, p] of [
      [24, 50, 1013],
      [-40, 0, 300],
      [85, 100, 1100],
      [21.5, 37, 987.5],
    ]) {
      dev.values = { temperature: t, humidity: h, pressure: p };
      const w = (dev as unknown as { adcWords(): { t: number; p: number; h: number } }).adcWords();
      const tf = bme280TFine(w.t);
      expect(Math.trunc((tf * 5 + 128) / 256) / 100).toBeCloseTo(t, 2);
      expect(bme280Pressure(w.p, tf) / 100).toBeCloseTo(p, 2);
      expect(bme280Humidity(w.h, tf)).toBeCloseTo(h, 2);
    }
  });

  it('BME680 T/P/H words decode to the panel values at the ends of the sliders', () => {
    const dev = new Bme680Model(0x77);
    for (const [t, h, p] of [
      [-40, 0, 300],
      [85, 100, 1100],
      [-40, 100, 1100],
      [85, 0.5, 300],
    ]) {
      dev.values = { temperature: t, humidity: h, pressure: p };
      const w = (dev as unknown as { adcWords(): { t: number; p: number; h: number } }).adcWords();
      const [temp, tf] = bme680Temperature(w.t);
      expect(temp).toBeCloseTo(t, 2);
      expect(bme680Pressure(w.p, tf) / 100).toBeCloseTo(p, 2);
      expect(bme680Humidity(w.h, tf)).toBeCloseTo(h, 2);
    }
  });

  it('BMP180 UT/UP decode to the panel values at the ends of the sliders (oss 0..3)', () => {
    for (const t of [-40, 0, 85]) {
      const ut = invertMonotonic(bmp180Tenths, t * 10, 20_000, 0xffff);
      expect(bmp180Tenths(ut)).toBe(t * 10);
      for (const oss of [0, 3]) {
        for (const p of [300, 1100]) {
          const up = invertMonotonic((a) => bmp180Pressure(a, ut, oss), p * 100, 0, (1 << (16 + oss)) - 1);
          expect(Math.abs(bmp180Pressure(up, ut, oss) - p * 100)).toBeLessThanOrEqual(oss ? 0 : 2);
        }
      }
    }
  });

  it('BME680 gas words cover 1..500 kΩ within the 10-bit ADC step', () => {
    const dev = new Bme680Model(0x77);
    for (const g of [1, 12, 100, 250, 500]) {
      dev.values = { gas: g };
      const w = (dev as unknown as { gasWord(): { adc: number; range: number } }).gasWord();
      expect(Math.abs(bme680GasLow(w.adc, w.range) / 1000 - g) / g).toBeLessThan(0.0008);
    }
  });

  type Dev = Bme280Model | Bme680Model | Bmp180Model;
  const reader = (dev: Dev) => (reg: number, n: number) => {
    dev.start(false);
    dev.writeByte(reg);
    dev.start(true);
    const bytes = Array.from({ length: n }, () => dev.readByte());
    dev.stop();
    return bytes;
  };
  const writer = (dev: Dev) => (...pairs: number[]) => {
    dev.start(false);
    pairs.forEach((b) => dev.writeByte(b));
    dev.stop();
  };

  it('BME280 forced mode: ctrl_hum applies at the ctrl_meas write, measuring shows once, back to sleep', () => {
    const dev = new Bme280Model(0x76);
    const read = reader(dev);
    const write = writer(dev);
    expect(read(0xd0, 1)).toEqual([0x60]);
    expect(read(0xfa, 3)).toEqual([0x80, 0, 0]);
    write(0xf2, 0x01);
    // Humidity is not measured until ctrl_meas is written.
    write(0xf4, 0x25);
    expect(read(0xf3, 1)).toEqual([0x08]);
    expect(read(0xf3, 1)).toEqual([0x00]);
    expect(read(0xf4, 1)).toEqual([0x24]);
    const data = read(0xf7, 8);
    expect(data[3]).not.toBe(0x80);
    expect(data.slice(6)).not.toEqual([0x80, 0]);
    write(0xe0, 0xb6);
    expect(read(0xf7, 8)).toEqual([0x80, 0, 0, 0x80, 0, 0, 0x80, 0]);
  });

  it('BME680 reports no new data until a forced measurement, then field 0 with gas_valid and heat_stab', () => {
    const dev = new Bme680Model(0x77);
    const read = reader(dev);
    const write = writer(dev);
    expect(read(0xd0, 1)).toEqual([0x61]);
    expect(read(0xf0, 1)).toEqual([0x00]);
    expect(read(0x1d, 1)[0] & 0x80).toBe(0);
    write(0x71, 0x10, 0x72, 0x02, 0x73, 0x00, 0x74, 0x8c, 0x75, 0x08);
    write(0x74, 0x8d);
    expect(read(0x74, 1)).toEqual([0x8c]);
    const field = read(0x1d, 17);
    expect(field[0] & 0x80).toBe(0x80);
    expect(field[14] & 0x30).toBe(0x30);
  });

  it('BMP180 answers id 0x55 and the datasheet calibration', () => {
    const dev = new Bmp180Model(0x77);
    const read = reader(dev);
    expect(read(0xd0, 1)).toEqual([0x55]);
    expect(read(0xaa, 2)).toEqual([0x01, 0x98]); // AC1 = 408
    expect(read(0xf6, 3)).toEqual([0x80, 0, 0]);
  });
});

describe('Bosch catalog modules under the compiled card examples (Uno)', () => {
  it('BME280: Adafruit_BME280 begin(0x76) finds the chip and prints the panel', () => {
    const b = bench('bme280');
    expect(b.lines(/^Temperature: /, 1)).toEqual(['Temperature: 24.00 C, humidity: 50.00 %, pressure: 1013.00 hPa']);
    dispatchSensorUpdate('bme280', { temperature: -12.5, humidity: 83, pressure: 950.5 });
    // The line being printed when the slider moved may still carry the old reading.
    expect(b.lines(/^Temperature: /, 2).pop()).toBe(
      'Temperature: -12.50 C, humidity: 83.00 %, pressure: 950.50 hPa',
    );
    expect(b.out()).not.toContain('not found');
  }, 120_000);

  it('BMP180: Adafruit_BMP085 begin() finds the chip and prints the panel', () => {
    const b = bench('bmp180');
    expect(b.lines(/^Temperature: /, 1)).toEqual(['Temperature: 24.00 C, pressure: 1013.00 hPa']);
    dispatchSensorUpdate('bmp180', { temperature: 31.5, pressure: 899.5 });
    expect(b.lines(/^Temperature: /, 2).pop()).toBe('Temperature: 31.50 C, pressure: 899.50 hPa');
    expect(b.out()).not.toContain('not found');
  }, 120_000);

  it('BME680: Adafruit_BME680 performReading() returns the panel, gas included', () => {
    const b = bench('bme680');
    expect(b.lines(/^T: /, 1, 8000)).toEqual(['T: 24.00 C, RH: 50.00 %, P: 1013.00 hPa, gas: 100.00 kOhm']);
    dispatchSensorUpdate('bme680', { temperature: 5.5, humidity: 21, pressure: 1050, gas: 12 });
    expect(b.lines(/^T: /, 2, 8000).pop()).toBe('T: 5.50 C, RH: 21.00 %, P: 1050.00 hPa, gas: 12.00 kOhm');
    expect(b.out()).not.toContain('failed');
    expect(b.out()).not.toContain('not found');
  }, 240_000);
});
