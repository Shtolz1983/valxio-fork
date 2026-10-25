/**
 * The catalog's single-wire models (partsCatalog/models/line.ts): DHT11 and
 * DS18B20 as line models on the data pin.
 *
 *   - real firmware: the cards' own examples, compiled for the Uno with the
 *     card's libraries (Adafruit DHT sensor library 1.4.7; OneWire 2.3.8 +
 *     DallasTemperature 4.0.6), run on avr8js with the module attached the
 *     way the canvas attaches a generic module. Serial shows the panel's
 *     values, and a panel change shows up on the next reading;
 *   - the protocol pieces: DHT11 payload, Dallas CRC-8, the ROM, the
 *     temperature register and scratchpad, and the 1-Wire slave driven slot by
 *     slot by a small master written here from the OneWire library's timing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry, type AnySimulator } from '../simulation/parts/PartSimulationRegistry';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { registerCardSimulations } from '../partsCatalog/simulation';
import { createLineModel, type LineClock, type LineModel } from '../simulation/line/lineModels';
import type { PadDrive, PadEvent } from '../simulation/line/padEvent';
import type { HostEdgeFrame } from '../simulation/line/LineTimeline';
import {
  dallasCrc8,
  dht11Payload,
  ds18b20ConversionMs,
  ds18b20RawTemperature,
  ds18b20Rom,
  ds18b20Scratchpad,
  DS18B20_POWER_ON_RAW,
} from '../partsCatalog/models/line';
import type { PartCard } from '../partsCatalog/types';

const CATALOG = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hex = (id: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/catalog-${id}/${id}.ino.hex`, import.meta.url)), 'utf8');

const CYCLES_PER_MS = 16_000;
/** exampleFor(card, 'uno') puts the first signal pin on D2. */
const UNO_DATA_PIN = 2;

// ── Real firmware ───────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function bench(id: string, dataPin: string) {
  const c = card(id);
  registerCardSimulations([c]);
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex(id));
  let out = '';
  sim.onSerialData = (ch: string) => {
    out += ch;
  };
  const componentId = `${id}-1`;
  const cleanup = PartSimulationRegistry.get(c.id)!.attachEvents!(
    { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} } as unknown as HTMLElement,
    sim as unknown as AnySimulator,
    (name) => (name === dataPin ? UNO_DATA_PIN : null),
    componentId,
  );
  cleanups.push(cleanup);
  const cycles = () => (sim as unknown as { cpu: { cycles: number } }).cpu.cycles;
  let seen = 0;
  return {
    componentId,
    out: () => out,
    /** Run until `count` more lines matching `pattern` are printed. */
    lines(pattern: RegExp, count: number, withinMs: number): string[] {
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
          throw new Error(`${found.length} of ${count} lines matching ${pattern}; printed ${JSON.stringify(out)}`);
        }
        for (let i = 0; i < 20_000; i++) sim.step();
      }
    },
  };
}

describe('DHT11 module under the card example (Adafruit DHT.h, type DHT11)', () => {
  it('prints the panel values and follows a change', () => {
    const b = bench('dht11', 'DATA');
    expect(b.lines(/^Temperature:/, 1, 5000)).toEqual(['Temperature: 25.00 C, humidity: 50.00 %']);
    dispatchSensorUpdate(b.componentId, { temperature: 37, humidity: 81 });
    expect(b.lines(/^Temperature:/, 1, 5000)).toEqual(['Temperature: 37.00 C, humidity: 81.00 %']);
    expect(b.out()).not.toMatch(/failed/);
  }, 60_000);
});

describe('DS18B20 module under the card example (OneWire + DallasTemperature)', () => {
  it('is found by begin(), prints the panel temperature and follows a change', () => {
    const b = bench('ds18b20', 'DQ');
    expect(b.lines(/^Temperature:|not found/, 1, 5000)).toEqual(['Temperature: 25.00 C']);
    dispatchSensorUpdate(b.componentId, { temperature: -12.5 });
    // The reading in flight may already be past its conversion: the change
    // shows up within two readings.
    const next = b.lines(/^Temperature:|not found/, 2, 6000);
    expect(next[1]).toBe('Temperature: -12.50 C');
    expect(b.out()).not.toMatch(/not found/);
  }, 120_000);
});

// ── DHT11 payload ───────────────────────────────────────────────────────────

describe('dht11Payload', () => {
  /** Adafruit DHT.h's DHT11 decoding. */
  const decode = (d: Uint8Array) => {
    let t = d[2];
    if (d[3] & 0x80) t = -1 - t;
    t += (d[3] & 0x0f) * 0.1;
    return { t, h: d[0] + d[1] * 0.1, ok: ((d[0] + d[1] + d[2] + d[3]) & 0xff) === d[4] };
  };

  it('puts integer and tenths in separate bytes with a byte-sum checksum', () => {
    expect([...dht11Payload(25, 50)]).toEqual([50, 0, 25, 0, 75]);
    expect([...dht11Payload(23.4, 61.2)]).toEqual([61, 2, 23, 4, 90]);
  });

  it('round-trips through the library decoding, below zero too', () => {
    for (const [t, h] of [
      [0, 20],
      [50, 90],
      [-2.3, 40],
      [-2, 40],
      [-0.5, 40],
    ]) {
      const d = decode(dht11Payload(t, h));
      expect(d.ok).toBe(true);
      expect(d.t).toBeCloseTo(t, 5);
      expect(d.h).toBeCloseTo(h, 5);
    }
  });
});

// ── DS18B20 data ────────────────────────────────────────────────────────────

describe('DS18B20 data', () => {
  it('Dallas CRC-8 matches Maxim AN27 (ROM 02 1C B8 01 00 00 00 -> A2)', () => {
    expect(dallasCrc8([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00])).toBe(0xa2);
    expect(dallasCrc8([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00, 0xa2])).toBe(0);
  });

  it('ROM: family 0x28, serial stable per seed, CRC over 7 bytes', () => {
    const rom = ds18b20Rom('ds18b20-1');
    expect(rom[0]).toBe(0x28);
    expect(rom[7]).toBe(dallasCrc8(rom, 7));
    expect(dallasCrc8(rom)).toBe(0);
    expect([...ds18b20Rom('ds18b20-1')]).toEqual([...rom]);
    expect([...ds18b20Rom('ds18b20-2')]).not.toEqual([...rom]);
  });

  it('temperature register matches the datasheet table', () => {
    expect(ds18b20RawTemperature(125)).toBe(0x07d0);
    expect(ds18b20RawTemperature(85)).toBe(0x0550);
    expect(ds18b20RawTemperature(25.0625)).toBe(0x0191);
    expect(ds18b20RawTemperature(10.125)).toBe(0x00a2);
    expect(ds18b20RawTemperature(0.5)).toBe(0x0008);
    expect(ds18b20RawTemperature(0)).toBe(0x0000);
    expect(ds18b20RawTemperature(-0.5)).toBe(0xfff8);
    expect(ds18b20RawTemperature(-10.125)).toBe(0xff5e);
    expect(ds18b20RawTemperature(-25.0625)).toBe(0xfe6f);
    expect(ds18b20RawTemperature(-55)).toBe(0xfc90);
    expect(ds18b20RawTemperature(200)).toBe(0x07d0);
  });

  it('lower resolutions leave the undefined low bits zero', () => {
    expect(ds18b20RawTemperature(25.0625, 9)).toBe(0x0190);
    expect(ds18b20RawTemperature(25.3, 10)).toBe(0x0194);
    expect(ds18b20RawTemperature(25.3, 11)).toBe(0x0194);
    expect(ds18b20ConversionMs(9)).toBe(93.75);
    expect(ds18b20ConversionMs(12)).toBe(750);
  });

  it('scratchpad: 9 bytes with the CRC of the first 8', () => {
    const sp = ds18b20Scratchpad(DS18B20_POWER_ON_RAW, 0x4b, 0x46, 0x7f, 0x0c);
    expect([...sp.slice(0, 8)]).toEqual([0x50, 0x05, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10]);
    expect(dallasCrc8(sp)).toBe(0);
  });
});

// ── DS18B20 1-Wire slave, slot by slot ──────────────────────────────────────

/** A 1-Wire master with OneWire's AVR timing, driving the line model's pad events. */
class Master {
  now = 0;
  readonly clock: LineClock = { now: () => this.now, us: (n) => Math.round(n * 16) };
  private drive: PadDrive = 'z';
  /** Frames the slave put on the wire. */
  readonly frames: HostEdgeFrame[] = [];

  private readonly model: LineModel;
  readonly pin: number;

  constructor(model: LineModel, pin = 2) {
    this.model = model;
    this.pin = pin;
  }

  private set(drive: PadDrive): HostEdgeFrame[] {
    const prev = { drive: this.drive, pull: 0 as const, level: this.drive === 'high', cycle: this.now };
    this.drive = drive;
    const e: PadEvent = { pin: this.pin, drive, pull: 0, level: drive === 'high', cycle: this.now, prev };
    const out = this.model.onPad(e, this.clock);
    const frames = !out ? [] : 'pin' in out ? [out] : [...out];
    this.frames.push(...frames);
    return frames;
  }

  private wait(us: number): void {
    this.now += this.clock.us(us);
  }

  /** Is the slave holding the line low at `cycle`? */
  private slaveLowAt(frames: HostEdgeFrame[], cycle: number): boolean {
    let level = true;
    for (const f of frames) for (const e of f.edges) if (e.atCycle <= cycle) level = e.level;
    return !level;
  }

  /** 480 us low, release, sample 70 us later: true when a slave answered presence. */
  reset(): boolean {
    this.set('low');
    this.wait(480);
    const frames = this.set('z');
    const sample = this.now + this.clock.us(70);
    this.wait(480);
    return this.slaveLowAt(frames, sample);
  }

  writeBit(bit: number): void {
    this.set('low');
    this.wait(bit ? 10 : 65);
    this.set('high');
    this.wait(bit ? 55 : 5);
  }

  readBit(): number {
    const frames = this.set('low');
    const sample = this.now + this.clock.us(13);
    this.wait(3);
    this.set('z');
    this.wait(63);
    return this.slaveLowAt(frames, sample) ? 0 : 1;
  }

  write(...bytes: number[]): void {
    for (const byte of bytes) for (let b = 0; b < 8; b++) this.writeBit((byte >> b) & 1);
  }

  read(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v |= this.readBit() << b;
      out.push(v);
    }
    return out;
  }

  /** Search ROM for a single device: every bit must come back with its complement. */
  search(cmd = 0xf0): number[] | null {
    if (!this.reset()) return null;
    this.write(cmd);
    const rom = new Array(8).fill(0);
    for (let i = 0; i < 64; i++) {
      const id = this.readBit();
      const cmp = this.readBit();
      if (id === 1 && cmp === 1) return null;
      expect(id).not.toBe(cmp);
      rom[i >> 3] |= id << (i & 7);
      this.writeBit(id);
    }
    return rom;
  }

  waitMs(ms: number): void {
    this.wait(ms * 1000);
  }
}

function ds18b20(temperature = 25, seed = 'ds18b20-1') {
  const model = createLineModel({ sensor_type: 'ds18b20', pin: 2, temperature, rom_seed: seed })!;
  expect(model).not.toBeNull();
  return { model, master: new Master(model), rom: [...ds18b20Rom(seed)] };
}

describe('DS18B20 1-Wire slave', () => {
  it('answers a reset with presence 30..150 us after the release', () => {
    const { master } = ds18b20();
    expect(master.reset()).toBe(true);
    const presence = master.frames[0];
    expect(presence.edges.map((e) => e.level)).toEqual([false, true]);
    expect(presence.edges[1].atCycle - presence.edges[0].atCycle).toBe(120 * 16);
  });

  it('Read ROM and Search ROM return the ROM', () => {
    const { master, rom } = ds18b20();
    expect(master.reset()).toBe(true);
    master.write(0x33);
    expect(master.read(8)).toEqual(rom);
    expect(master.search()).toEqual(rom);
  });

  it('powers on with 85 °C (0x0550) and byte 6 = 0x0C in the scratchpad', () => {
    const { master } = ds18b20();
    master.reset();
    master.write(0xcc, 0xbe);
    const sp = master.read(9);
    expect(sp).toEqual([...ds18b20Scratchpad(0x0550, 0x4b, 0x46, 0x7f, 0x0c)]);
  });

  it('Convert T: read slots answer 0 for 750 ms, then 1; the register holds the panel value', () => {
    const { master, model } = ds18b20(21.5);
    master.reset();
    master.write(0xcc, 0x44);
    expect(master.readBit()).toBe(0);
    master.waitMs(700);
    expect(master.readBit()).toBe(0);
    master.waitMs(51);
    expect(master.readBit()).toBe(1);
    model.update({ temperature: 30 }, master.clock);
    master.reset();
    master.write(0xcc, 0xbe);
    const sp = master.read(9);
    expect(dallasCrc8(sp)).toBe(0);
    expect(sp[0] | (sp[1] << 8)).toBe(ds18b20RawTemperature(21.5));
    expect(sp[6]).toBe(0x10 - (sp[0] & 0x0f));
  });

  it('Match ROM selects only its own ROM', () => {
    const { master, rom } = ds18b20(-10.125);
    master.reset();
    master.write(0x55, ...rom, 0x44);
    master.waitMs(800);
    master.reset();
    master.write(0x55, ...rom, 0xbe);
    const sp = master.read(9);
    expect(sp[0] | (sp[1] << 8)).toBe(0xff5e);

    const other = [...rom];
    other[3] ^= 1;
    master.reset();
    master.write(0x55, ...other, 0xbe);
    expect(master.read(9)).toEqual(new Array(9).fill(0xff));
  });

  it('Write Scratchpad sets TH/TL and the resolution; 9-bit converts in 93.75 ms', () => {
    const { master } = ds18b20(25.3);
    master.reset();
    master.write(0xcc, 0x4e, 30, 0xf6, 0x1f);
    master.reset();
    master.write(0xcc, 0x44);
    master.waitMs(93);
    expect(master.readBit()).toBe(0);
    master.waitMs(1);
    expect(master.readBit()).toBe(1);
    master.reset();
    master.write(0xcc, 0xbe);
    const sp = master.read(9);
    expect(sp.slice(2, 5)).toEqual([30, 0xf6, 0x1f]);
    expect(sp[0] | (sp[1] << 8)).toBe(ds18b20RawTemperature(25.3, 9));
  });

  it('Read Power Supply answers 1 (externally powered)', () => {
    const { master } = ds18b20();
    master.reset();
    master.write(0xcc, 0xb4);
    expect(master.readBit()).toBe(1);
  });

  it('Alarm Search answers only while T >= TH or T <= TL', () => {
    const { master, model, rom } = ds18b20(25);
    master.reset();
    master.write(0xcc, 0x4e, 30, 10, 0x7f);
    master.reset();
    master.write(0xcc, 0x44);
    master.waitMs(800);
    expect(master.search(0xec)).toBeNull();
    model.update({ temperature: 30.5 }, master.clock);
    master.reset();
    master.write(0xcc, 0x44);
    master.waitMs(800);
    expect(master.search(0xec)).toEqual(rom);
  });

  it('a mismatching search direction deselects the device until the next reset', () => {
    const { master, rom } = ds18b20();
    master.reset();
    master.write(0xf0);
    const id = master.readBit();
    master.readBit();
    master.writeBit(id ^ 1);
    expect([master.readBit(), master.readBit()]).toEqual([1, 1]);
    expect(master.search()).toEqual(rom);
  });
});
