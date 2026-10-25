// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Aht20Model, Bh1750Model, Sht31Model, crc8 } from '../partsCatalog/simModels';
import { analogVolts, digitalLevel, interpolate, registerCardSimulations } from '../partsCatalog/simulation';
import { PartSimulationRegistry, type AnySimulator } from '../simulation/parts/PartSimulationRegistry';
import { getSensorControl } from '../simulation/sensorControlConfig';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import type { FrameDevice } from '../partsCatalog/simModels';
import type { PartCard } from '../partsCatalog/types';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;

/** One write phase, then one read phase, in the order the bus fabric calls a target. */
function transact(dev: FrameDevice, write: number[], readLen: number): number[] {
  dev.start(false);
  write.forEach((b) => dev.writeByte(b));
  dev.stop();
  if (readLen === 0) return [];
  dev.start(true);
  const out = Array.from({ length: readLen }, () => dev.readByte());
  dev.stop();
  return out;
}

describe('card simulation outputs', () => {
  it('interpolates between the points and holds the ends', () => {
    const pts: Array<[number, number]> = [[0, 2.54], [100, 1.27]];
    expect(interpolate(pts, 0)).toBe(2.54);
    expect(interpolate(pts, 50)).toBeCloseTo(1.905);
    expect(interpolate(pts, 150)).toBe(1.27);
    expect(interpolate(pts, -10)).toBe(2.54);
  });

  it('clamps analog volts to the board rail and scales ratios by it', () => {
    expect(analogVolts({ pin: 'A', kind: 'analog', from: 'x', volts: [[0, 0], [10, 5]] }, 10, 3.3)).toBe(3.3);
    expect(analogVolts({ pin: 'A', kind: 'analog', from: 'x', ratio: [[0, 0], [10, 1]] }, 5, 5)).toBe(2.5);
  });

  it('drives digital levels from thresholds, switches and active-low outputs', () => {
    expect(digitalLevel({ pin: 'D', kind: 'digital', from: 'x', above: 50, activeLow: true }, 80)).toBe(false);
    expect(digitalLevel({ pin: 'D', kind: 'digital', from: 'x', above: 50, activeLow: true }, 20)).toBe(true);
    expect(digitalLevel({ pin: 'D', kind: 'digital', from: 'x', below: 10 }, 5)).toBe(true);
    expect(digitalLevel({ pin: 'D', kind: 'digital', from: 'x' }, 1)).toBe(true);
    expect(digitalLevel({ pin: 'D', kind: 'digital', from: 'x', activeLow: true }, 1)).toBe(false);
  });
});

describe('I2C register models', () => {
  it('computes the Sensirion CRC-8 test vector', () => {
    expect(crc8([0xbe, 0xef])).toBe(0x92);
  });

  it('SHT31 answers a high-repeatability measurement the way Adafruit_SHT31 decodes it', () => {
    const dev = new Sht31Model(0x44);
    dev.values = { temperature: 23.5, humidity: 61 };
    // begin(): soft reset, then the status register must not read 0xFFFF.
    transact(dev, [0x30, 0xa2], 0);
    const status = transact(dev, [0xf3, 0x2d], 3);
    expect((status[0] << 8) | status[1]).not.toBe(0xffff);
    const b = transact(dev, [0x24, 0x00], 6);
    expect(b[2]).toBe(crc8(b.slice(0, 2)));
    expect(b[5]).toBe(crc8(b.slice(3, 5)));
    const t = (((4375 * ((b[0] << 8) | b[1])) >> 14) - 4500) / 100;
    const h = ((625 * ((b[3] << 8) | b[4])) >> 12) / 100;
    expect(t).toBeCloseTo(23.5, 1);
    expect(h).toBeCloseTo(61, 1);
  });

  it('AHT20 reports calibrated and not busy, then a frame Adafruit_AHTX0 decodes', () => {
    const dev = new Aht20Model(0x38);
    dev.values = { temperature: -12.5, humidity: 33 };
    transact(dev, [0xba], 0);
    const [status] = transact(dev, [0xbe, 0x08, 0x00], 1);
    expect(status & 0x80).toBe(0);
    expect(status & 0x08).toBe(0x08);
    transact(dev, [0xac, 0x33, 0x00], 0);
    // getStatus() polls with a one-byte read, then the six data bytes.
    dev.start(true);
    expect(dev.readByte() & 0x80).toBe(0);
    dev.stop();
    dev.start(true);
    const d = Array.from({ length: 7 }, () => dev.readByte());
    const h = (((d[1] << 8) | d[2]) << 4) | (d[3] >> 4);
    const t = ((d[3] & 0x0f) << 16) | (d[4] << 8) | d[5];
    expect((h * 100) / 0x100000).toBeCloseTo(33, 1);
    expect((t * 200) / 0x100000 - 50).toBeCloseTo(-12.5, 1);
    expect(d[6]).toBe(crc8(d.slice(0, 6)));
  });

  it('BH1750 counts 1.2 per lux, scaled by the measurement time and mode 2', () => {
    const dev = new Bh1750Model(0x23);
    dev.values = { lux: 500 };
    transact(dev, [0x01], 0);
    transact(dev, [0x10], 0);
    let raw = transact(dev, [], 2);
    expect(((raw[0] << 8) | raw[1]) / 1.2).toBeCloseTo(500, 0);
    // setMTreg(138): the library divides by 138/69 again.
    transact(dev, [0x40 | (138 >> 5)], 0);
    transact(dev, [0x60 | (138 & 0x1f)], 0);
    transact(dev, [0x11], 0);
    raw = transact(dev, [], 2);
    expect(((raw[0] << 8) | raw[1]) * (69 / 138) / 2 / 1.2).toBeCloseTo(500, 0);
  });
});

describe('registered module simulation', () => {
  it('gives a card with sim a sensor panel and drives its pins from the sliders', () => {
    const rain = card('rain-sensor');
    registerCardSimulations([rain]);
    expect(getSensorControl('rain-sensor')?.controls.map((c) => c.key)).toEqual(['rain']);

    const adc: Record<number, number> = {};
    const levels: Record<number, boolean> = {};
    // An ESP32 bridge-shaped simulator: it takes ADC volts itself (3.3 V rail).
    const sim = {
      pinManager: {} as AnySimulator['pinManager'],
      isRunning: () => true,
      setAdcVoltage: (pin: number, v: number) => ((adc[pin] = v), true),
      setPinState: (pin: number, s: boolean) => (levels[pin] = s),
    };
    const pinOf: Record<string, number> = { AO: 34, DO: 4 };
    const logic = PartSimulationRegistry.get('rain-sensor');
    const cleanup = logic!.attachEvents!(document.createElement('div'), sim, (n) => pinOf[n] ?? null, 'rain-sensor-1');

    expect(adc[34]).toBeCloseTo(0.98 * 3.3);
    expect(levels[4]).toBe(true);
    dispatchSensorUpdate('rain-sensor-1', { rain: 80 });
    expect(adc[34]).toBeCloseTo((0.98 - 0.78 * 0.8) * 3.3);
    expect(levels[4]).toBe(false);
    cleanup();
  });

  it('skips cards that place an existing part or have no sim', () => {
    const silent = { ...card('ds18b20'), id: 'silent-module', sim: undefined };
    registerCardSimulations([card('dht22'), silent]);
    expect(getSensorControl('silent-module')).toBeUndefined();
    expect(PartSimulationRegistry.get('silent-module')).toBeUndefined();
  });
});

describe('catalogue cards and simulator models agree', async () => {
  const { getModuleModel, moduleModelNames } = await import('../partsCatalog/models');
  // The bridge's card check lists the same models; the two lists must not drift.
  // @ts-expect-error -- the bridge is plain JavaScript without type declarations
  const bridgeModule: unknown = await import('../../../ai-bridge/partCards.mjs');
  const bridge = bridgeModule as { SIM_MODELS: Record<string, string[]>; ESP32_SIM_MODELS: string[] };
  const { ESP32_SIM_MODELS } = await import('../partsCatalog/catalog');
  const { SIM_MODELS } = bridge;
  const cards = readdirSync(CATALOG)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(CATALOG, f), 'utf8')) as PartCard);

  it('registers every model the bridge accepts, with the same control keys', () => {
    expect(moduleModelNames()).toEqual(Object.keys(SIM_MODELS).sort());
    for (const [name, keys] of Object.entries(SIM_MODELS)) expect(getModuleModel(name)?.keys, name).toEqual(keys);
  });

  it('the ESP32 model list is one list on both sides, of models that exist', () => {
    expect(ESP32_SIM_MODELS).toEqual(bridge.ESP32_SIM_MODELS);
    for (const m of ESP32_SIM_MODELS) expect(getModuleModel(m), m).toBeDefined();
  });

  it('names only models the simulator has', () => {
    // A card the AI author writes for a new part may have no simulator
    // behaviour at all; one that names a model must name a real one.
    for (const c of cards) {
      if (c.sim?.model) expect(getModuleModel(c.sim.model), c.id).toBeDefined();
    }
  });
});
