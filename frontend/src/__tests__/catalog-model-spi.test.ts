// @vitest-environment jsdom
/**
 * SPI chip models of the parts catalogue (partsCatalog/models/spi.ts) against
 * the cards' own examples, compiled for the Uno with the real libraries
 * (fixtures/catalog-<id>/, pins filled the way ai-bridge exampleFor does):
 *
 *   - MAX6675: the library bit-bangs SCK 2 / SO 3 / CS 10, so the chip is
 *     served by the fabric's software SPI decoder;
 *   - MAX31865: Adafruit_MAX31865(CS) is hardware SPI (mode 1) on 13/11/12;
 *   - RC522: MFRC522 on hardware SPI, SS 10, RST 2.
 *
 * The part is attached as the canvas does (registerCardSimulations, then the
 * registry's attachEvents under a component id); a resolver says where the
 * module's pins land on the board. Serial must show the panel value, and a
 * panel change (dispatchSensorUpdate) must show up in the next reading.
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
import {
  crcA,
  max31865LibraryCelsius,
  max31865Raw,
  max6675Word,
  Mfrc522Model,
  cardSpiPins,
} from '../partsCatalog/models/spi';
import type { PartCard } from '../partsCatalog/types';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const BOARD = 'uno-1';

const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hex = (id: string) => readFileSync(path.join(FIXTURES, `catalog-${id}`, `${id}.ino.hex`), 'utf8');

/** A circuit where the module's pins (by name) land on the given Uno pins. */
function circuit(componentId: string, wiring: Record<string, number>): NetResolver {
  return {
    resolve: (ref) =>
      ref.kind === 'board'
        ? { kind: 'board', boardId: ref.boardId, pin: ref.pin }
        : ref.componentId === componentId && wiring[ref.pinName] !== undefined
          ? { kind: 'board', boardId: BOARD, pin: wiring[ref.pinName] }
          : { kind: 'floating' },
    boardKind: () => 'arduino-uno',
    boards: () => [BOARD],
  };
}

interface Bench {
  sim: AVRSimulator;
  out: () => string;
  /** Run until `pred` holds on the serial text, or the cycle budget runs out. */
  runUntil: (pred: (out: string) => boolean, budget?: number) => void;
  cleanup: () => void;
}

function bench(id: string, componentId: string, wiring: Record<string, number>): Bench {
  const c = card(id);
  registerCardSimulations([c]);
  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(hex(id));
  busRegistry.setResolver(circuit(componentId, wiring));
  busRegistry.bindEngine(BOARD, sim.getBusBinding());
  const logic = PartSimulationRegistry.get(id);
  expect(logic?.attachEvents).toBeTypeOf('function');
  const cleanup = logic!.attachEvents!(
    document.createElement('div'),
    sim as unknown as AnySimulator,
    (pin) => wiring[pin] ?? null,
    componentId,
  );
  let text = '';
  sim.onSerialData = (ch: string) => {
    text += ch;
  };
  return {
    sim,
    out: () => text,
    runUntil(pred, budget = 40_000_000) {
      for (let i = 0; i < budget; i++) {
        sim.step();
        if ((i & 0x3ff) === 0 && pred(text)) return;
      }
    },
    cleanup: () => (cleanup as (() => void) | undefined)?.(),
  };
}

/** Lines of the serial text that match `re`, in order. */
const lines = (text: string, re: RegExp) => text.split(/\r?\n/).filter((l) => re.test(l));

afterEach(() => busRegistry.clear());

describe('SPI chip models (unit)', () => {
  it('finds SPI legs by role, then by silkscreen name', () => {
    expect(cardSpiPins(card('max6675'))).toEqual({ sck: 'SCK', miso: 'SO', cs: 'CS' });
    expect(cardSpiPins(card('max31865'))).toEqual({ sck: 'CLK', mosi: 'SDI', miso: 'SDO', cs: 'CS' });
    expect(cardSpiPins(card('rc522'))).toEqual({ sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'SDA' });
  });

  it('MAX6675 word: quarter degrees in D14..D3, open-input bit clear', () => {
    expect(max6675Word(25)).toBe(100 << 3);
    expect(max6675Word(1023.75)).toBe(4095 << 3);
    expect(max6675Word(-5)).toBe(0);
    expect(max6675Word(25) & 0x4).toBe(0);
  });

  it('MAX31865 code decodes to the panel temperature through the library formula', () => {
    for (const t of [-200, -40, -0.5, 0, 25, 100, 400, 850]) {
      expect(max31865LibraryCelsius(max31865Raw(t))).toBeCloseTo(t, 1);
    }
  });

  it('CRC_A matches the ISO 14443-3 vector', () => {
    // SAK 0x08 -> CRC_A B6 DD; REQA-less vector: 00 00 -> A0 1E.
    expect(crcA([0x08])).toBe(0xddb6);
    expect(crcA([0x00, 0x00])).toBe(0x1ea0);
  });

  it('MFRC522 answers VersionReg 0x92 over the read framing', () => {
    const m = new Mfrc522Model();
    m.values = { card: 1, tag: 0 };
    m.select();
    expect(m.transfer(0x80 | (0x37 << 1))).toBe(0);
    expect(m.transfer(0)).toBe(0x92);
    m.deselect();
  });
});

describe('SPI chip models — real firmware of the card examples (Uno)', () => {
  it('MAX6675: bit-banged readCelsius() prints the panel temperature, then the new one', () => {
    const b = bench('max6675', 'max6675-1', { SCK: 2, SO: 3, CS: 10 });
    b.runUntil((o) => /Thermocouple: [\d.]+ C\r?\n/.test(o));
    expect(b.out()).toContain('Thermocouple: 25.00 C');

    dispatchSensorUpdate('max6675-1', { temperature: 432.75 });
    b.runUntil((o) => /432\.75 C\r?\n/.test(o));
    expect(b.out()).toContain('Thermocouple: 432.75 C');
    expect(b.out()).not.toContain('nan');
    b.cleanup();
  }, 120_000);

  it('MAX31865: hardware-SPI temperature(100, 430) prints the panel temperature, then the new one', () => {
    const b = bench('max31865', 'max31865-1', { CLK: 13, SDI: 11, SDO: 12, CS: 10 });
    b.runUntil((o) => /(Temperature: -?[\d.]+ C|Fault 0x\w+)\r?\n/.test(o));
    const first = lines(b.out(), /Temperature: /)[0];
    expect(first).toBeDefined();
    expect(Number(first.match(/Temperature: (-?[\d.]+)/)![1])).toBeCloseTo(25, 1);
    expect(b.out()).not.toContain('Fault');

    dispatchSensorUpdate('max31865-1', { temperature: -78.5 });
    b.runUntil((o) => /Temperature: -[\d.]+ C\r?\n/.test(o));
    const neg = lines(b.out(), /Temperature: -/)[0];
    expect(neg).toBeDefined();
    expect(Number(neg.match(/Temperature: (-?[\d.]+)/)![1])).toBeCloseTo(-78.5, 1);

    dispatchSensorUpdate('max31865-1', { temperature: 600 });
    b.runUntil((o) => /Temperature: 6[\d.]+ C\r?\n/.test(o));
    const hot = lines(b.out(), /Temperature: 6\d\d/)[0];
    expect(Number(hot.match(/Temperature: (-?[\d.]+)/)![1])).toBeCloseTo(600, 1);
    expect(b.out()).not.toContain('Fault');
    b.cleanup();
  }, 120_000);

  it('RC522: no tag, nothing read; a tag prints its UID once; another tag prints its own', () => {
    const b = bench('rc522', 'rc522-1', { SDA: 10, SCK: 13, MOSI: 11, MISO: 12, RST: 2 });
    dispatchSensorUpdate('rc522-1', { card: 0, tag: 0 });
    b.runUntil((o) => o.includes('reader\r\n'));
    expect(b.out()).toContain('Hold a card near the reader');
    // Many loop() passes with an empty field: REQA times out every time.
    b.runUntil(() => false, 8_000_000);
    expect(b.out()).not.toContain('Card UID');

    dispatchSensorUpdate('rc522-1', { card: 1 });
    b.runUntil((o) => /Card UID:.*\r?\n/.test(o));
    expect(lines(b.out(), /Card UID/)).toEqual(['Card UID: DE AD BE EF']);
    // Halted after the read: the tag stays on the reader and is not read again.
    b.runUntil(() => false, 4_000_000);
    expect(lines(b.out(), /Card UID/)).toHaveLength(1);

    dispatchSensorUpdate('rc522-1', { tag: 1 });
    b.runUntil((o) => (o.match(/Card UID:.*\r?\n/g) ?? []).length >= 2);
    expect(lines(b.out(), /Card UID/)).toEqual(['Card UID: DE AD BE EF', 'Card UID: 12 34 56 78']);

    // Taken away and put back: read again.
    dispatchSensorUpdate('rc522-1', { card: 0 });
    b.runUntil(() => false, 2_000_000);
    dispatchSensorUpdate('rc522-1', { card: 1, tag: 3 });
    b.runUntil((o) => (o.match(/Card UID:.*\r?\n/g) ?? []).length >= 3);
    expect(lines(b.out(), /Card UID/)[2]).toBe('Card UID: 04 7F 3A 91');
    b.cleanup();
  }, 120_000);
});
