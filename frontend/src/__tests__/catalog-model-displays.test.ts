// @vitest-environment jsdom
/**
 * The display models of the parts catalogue (partsCatalog/models/displays.ts)
 * under firmware that was compiled, not imitated: the cards' own examples
 * (fixtures/catalog-<id>/<id>.ino, pins filled the way the bridge's
 * exampleFor(card, 'uno') fills them) plus one sketch per model for the paths
 * the example does not take, on avr8js, each module attached the way the
 * canvas attaches it (registerCardSimulations, then the part's attachEvents
 * with a real <velxio-sensor-module>). What is asserted is what the module
 * shows at that moment of the sketch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import '../components/velxio-components/SensorModuleElement';
import type { ModuleDisplay } from '../components/velxio-components/SensorModuleElement';
import { cardMetadata } from '../partsCatalog/catalog';
import { registerCardSimulations } from '../partsCatalog/simulation';
import { Max7219Chip, Tm1637Decoder, max7219Display } from '../partsCatalog/models/displays';
import { getModuleModel } from '../partsCatalog/models/registry';
import type { PartCard } from '../partsCatalog/types';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { PartSimulationRegistry } from '../simulation/parts/PartSimulationRegistry';
import { busRegistry } from '../simulation/buses';
import type { NetResolver, PinRef, ResolvedPin } from '../simulation/buses/types';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;
const hex = (dir: string, name: string) =>
  readFileSync(path.join(__dirname, 'fixtures', dir, `${name}.ino.hex`), 'utf-8');

const UNO = 'uno';
const CYCLES_PER_MS = 16_000;

/** The circuit as the fabric sees it: component pins on Uno pins. */
class Circuit implements NetResolver {
  readonly nets = new Map<string, number>();
  resolve(ref: PinRef): ResolvedPin {
    if (ref.kind === 'board') return { kind: 'board', boardId: ref.boardId, pin: ref.pin };
    const pin = this.nets.get(`${ref.componentId}:${ref.pinName}`);
    return pin === undefined ? { kind: 'floating' } : { kind: 'board', boardId: UNO, pin };
  }
  boardKind(boardId: string) {
    return boardId === UNO ? 'arduino-uno' : undefined;
  }
  boards() {
    return [UNO];
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = '';
});

interface ModuleElement extends HTMLElement {
  moduleDisplay: ModuleDisplay | null;
  moduleDisplayKind: string;
  pinInfo: Array<{ name: string; x: number; y: number }>;
}

/**
 * A Uno running `firmware`, the card's module wired to it as `wiring` says
 * (card pin -> Uno pin) and attached as the canvas attaches it.
 */
function bench(id: string, firmware: string, wiring: Record<string, number>) {
  const c = card(id);
  registerCardSimulations([c]);
  const meta = cardMetadata(c);
  const el = document.createElement(meta.tagName) as ModuleElement;
  for (const [k, v] of Object.entries(meta.defaultValues ?? {})) (el as unknown as Record<string, unknown>)[k] = v;
  document.body.appendChild(el);

  const sim = new AVRSimulator(new PinManager(), 'uno');
  sim.loadHex(firmware);
  const circuit = new Circuit();
  const componentId = `${id}-1`;
  for (const [pin, boardPin] of Object.entries(wiring)) circuit.nets.set(`${componentId}:${pin}`, boardPin);
  busRegistry.setResolver(circuit);
  busRegistry.bindBoard(UNO, sim);
  busRegistry.netlistChanged();

  const detach = PartSimulationRegistry.get(c.id)!.attachEvents!(
    el,
    sim as never,
    (pin) => wiring[pin] ?? null,
    componentId,
  );
  cleanups.push(() => {
    detach();
    busRegistry.unbindBoard(UNO);
    busRegistry.netlistChanged();
  });

  const cpu = (sim as unknown as { cpu: { cycles: number } }).cpu;
  return {
    el,
    /** Run the sketch until `ms` of guest time since reset. */
    at(ms: number): ModuleDisplay {
      const end = ms * CYCLES_PER_MS;
      while (cpu.cycles < end) for (let i = 0; i < 10_000; i++) sim.step();
      return el.moduleDisplay!;
    },
  };
}

/** The rows of a matrix display ([] for any other). */
const rows = (d: ModuleDisplay) => (d.kind === 'matrix' ? d.rows : []);

/** Segment bytes of TM1637Display's digit table. */
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const MINUS = 0x40;

/** The lit cells of a module's display, in paint order. */
const litCells = (el: HTMLElement) =>
  Array.from(el.shadowRoot!.querySelectorAll('[data-c]')).map((n) => n.getAttribute('fill') === '#ff2a1a');

describe('TM1637 (avishorp TM1637Display) on an Arduino Uno, compiled', () => {
  const WIRING = { CLK: 2, DIO: 3 };

  it('the card example counts up once a second at brightness 5', () => {
    const b = bench('tm1637', hex('catalog-tm1637', 'tm1637'), WIRING);
    // Before the first transaction the module is blank and dark.
    expect(b.el.moduleDisplay).toMatchObject({ kind: '7seg', digits: [0, 0, 0, 0], on: false });
    expect(b.at(500)).toMatchObject({ kind: '7seg', digits: [0, 0, 0, SEG[0]], colon: false, on: true });
    expect(b.el.moduleDisplay!.brightness).toBeCloseTo(12 / 14); // brightness 5: 12/16 pulse width
    expect(b.at(1500)).toMatchObject({ digits: [0, 0, 0, SEG[1]], on: true });
    expect(b.at(2500)).toMatchObject({ digits: [0, 0, 0, SEG[2]], on: true });
    // What the module draws: "2" (a, b, d, e, g) on the last digit, nothing
    // else. Cells: 8 per digit (a..g, point) and the colon after digit 2.
    const lit = litCells(b.el);
    expect(lit.filter(Boolean)).toHaveLength(5);
    expect(lit.slice(25, 32)).toEqual([true, true, false, true, true, false, true]);
  }, 120_000);

  it('shows the colon, switches the display off and takes raw segments', () => {
    const b = bench('tm1637', hex('catalog-tm1637', 'tm1637-states'), WIRING);
    expect(b.at(100)).toMatchObject({
      digits: [SEG[1], SEG[2] | 0x80, SEG[3], SEG[4]],
      colon: true,
      on: true,
      brightness: 1,
    });
    expect(b.at(300)).toMatchObject({ digits: [0, 0, MINUS, SEG[5]], colon: false, on: false });
    expect(litCells(b.el).some(Boolean)).toBe(false);
    expect(b.at(500)).toMatchObject({ digits: [0x76, 0x79, 0x38, 0x3f], colon: false, on: true });
    expect(b.el.moduleDisplay!.brightness).toBeCloseTo(10 / 14);
  }, 120_000);

  it('holds DIO low for the ACK and reads every byte, whatever the line did around it', () => {
    const d = new Tm1637Decoder();
    const acks: boolean[] = [];
    d.onAck = (low) => acks.push(low);
    const write = (bytes: number[]) => {
      d.setDio(false); // START
      for (const byte of bytes) {
        for (let i = 0; i < 8; i++) {
          d.setClk(false);
          d.setDio(((byte >> i) & 1) === 1);
          d.setClk(true);
        }
        d.setClk(false);
        d.setDio(true); // the master lets go: the chip holds it low
        d.setClk(true);
        d.setDio(false); // the library drives it low on an ACK, CLK still high
        d.setClk(false);
      }
      d.setClk(true);
      d.setDio(true); // STOP
    };
    write([0x40]);
    write([0xc2, 0x5b, 0x4f]);
    write([0x8f]);
    expect(d.state).toEqual({ grids: [0, 0, 0x5b, 0x4f, 0, 0], on: true, brightness: 7 });
    expect(acks).toEqual([true, false, true, false, true, false, true, false, true, false]);
  });
});

describe('TM1637 on a board that reports pad direction only (ESP32 under QEMU)', () => {
  it('reads a line as low while its pad is an output at latch 0, released as high', () => {
    const c = card('tm1637');
    registerCardSimulations([c]);
    const el = document.createElement(cardMetadata(c).tagName) as ModuleElement;
    document.body.appendChild(el);
    const pm = new PinManager();
    const injected: Array<[number, boolean]> = [];
    const CLK = 18;
    const DIO = 19;
    const inst = getModuleModel('tm1637')!.attach({
      card: c,
      componentId: 'tm1637-1',
      element: el,
      simulator: { pinManager: pm, setPinState: (pin: number, high: boolean) => injected.push([pin, high]) } as never,
      getArduinoPin: (name) => ({ CLK, DIO })[name as 'CLK' | 'DIO'] ?? null,
      values: {},
    });
    cleanups.push(() => inst.dispose());
    // avishorp TM1637Display on the worker: both latches stay 0, a line is
    // pulled low by pinMode(OUTPUT) and let go by pinMode(INPUT); nothing
    // answers the ACK, so the guest reads it high and carries on.
    const low = (pin: number) => pm.setPinDirection(pin, 1);
    const release = (pin: number) => pm.setPinDirection(pin, 0);
    const line = (pin: number, high: boolean) => (high ? release(pin) : low(pin));
    release(CLK);
    release(DIO);
    const write = (bytes: number[]) => {
      low(DIO); // START
      for (const byte of bytes) {
        for (let i = 0; i < 8; i++) {
          low(CLK);
          line(DIO, ((byte >> i) & 1) === 1);
          release(CLK);
        }
        low(CLK);
        release(DIO);
        release(CLK); // the ACK clock
        low(CLK);
      }
      low(DIO);
      release(CLK);
      release(DIO); // STOP
    };
    const before = injected.length;
    write([0x40]);
    write([0xc0, SEG[1], SEG[2], SEG[3], SEG[4]]);
    write([0x8d]);
    expect(el.moduleDisplay).toMatchObject({ kind: '7seg', digits: [SEG[1], SEG[2], SEG[3], SEG[4]], on: true });
    expect(injected.length).toBe(before);
  });
});

describe('MAX7219 matrix (MD_MAX72XX, FC16_HW, bit-banged) on an Arduino Uno, compiled', () => {
  const WIRING = { DIN: 2, CLK: 3, CS: 10 };
  const FULL = 0xff;

  it('the card example fills the rows from the top, then clears', () => {
    const b = bench('max7219-matrix', hex('catalog-max7219-matrix', 'max7219-matrix'), WIRING);
    // Power-on: the chip is shut down.
    expect(b.el.moduleDisplay).toMatchObject({ kind: 'matrix', on: false });
    expect(b.at(50)).toEqual({ kind: 'matrix', rows: [FULL, 0, 0, 0, 0, 0, 0, 0], on: true, brightness: 5 / 16 });
    expect(rows(b.at(350))).toEqual([FULL, FULL, FULL, FULL, 0, 0, 0, 0]);
    expect(rows(b.at(750))).toEqual(Array(8).fill(FULL));
    expect(litCells(b.el).every(Boolean)).toBe(true);
    expect(b.at(950)).toMatchObject({ rows: Array(8).fill(0), on: true });
    expect(rows(b.at(1150))).toEqual([FULL, 0, 0, 0, 0, 0, 0, 0]);
  }, 120_000);

  it('puts MD_MAX72XX points where an FC-16 module lights them; shutdown and scan limit', () => {
    const b = bench('max7219-matrix', hex('catalog-max7219-matrix', 'max7219-matrix-points'), WIRING);
    // setPoint(0,0): top RIGHT; (2,5): row 2, third from the left; (7,7): bottom left.
    expect(b.at(50)).toMatchObject({ rows: [0x01, 0, 0x20, 0, 0, 0, 0, 0x80], on: true });
    const lit = litCells(b.el);
    expect(lit.flatMap((on, i) => (on ? [[Math.floor(i / 8), i % 8]] : []))).toEqual([
      [0, 7],
      [2, 2],
      [7, 0],
    ]);
    expect(b.at(150)).toMatchObject({ on: false });
    expect(litCells(b.el).some(Boolean)).toBe(false);
    // Scan limit 3: digits 4..7 are not scanned.
    expect(b.at(250)).toMatchObject({ rows: [0x01, 0, 0x20, 0, 0, 0, 0, 0], on: true });
  }, 120_000);

  it('decodes Code B and display test the way the chip does', () => {
    const chip = new Max7219Chip();
    chip.write(0x0c, 0x01);
    chip.write(0x0b, 0x07);
    chip.write(0x09, 0x01); // decode digit 0 only
    chip.write(0x01, 0x83); // "3." -> DP A B C D G
    chip.write(0x02, 0x83);
    expect(rows(max7219Display(chip)).slice(0, 2)).toEqual([0xf9, 0x83]);
    chip.write(0x0f, 0x01);
    expect(max7219Display(chip)).toMatchObject({ rows: Array(8).fill(0xff), on: true });
  });
});

describe('<velxio-sensor-module> with a display', () => {
  const make = (pins: string, kind: string) => {
    const el = document.createElement('velxio-sensor-module') as ModuleElement;
    (el as unknown as { modulePins: string }).modulePins = pins;
    el.moduleDisplayKind = kind;
    document.body.appendChild(el);
    return el;
  };
  const svgSize = (el: HTMLElement) => {
    const svg = el.shadowRoot!.querySelector('svg')!;
    return { width: Number(svg.getAttribute('width')), height: Number(svg.getAttribute('height')) };
  };

  it.each([
    ['CLK,DIO,VCC,GND', '7seg'],
    ['VCC,GND,DIN,CS,CLK', 'matrix'],
  ])('%s with a %s display: the pins stay on the top edge', (pins, kind) => {
    const plain = make(pins, '');
    const el = make(pins, kind);
    const { width, height } = svgSize(el);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(svgSize(plain).height);
    expect(el.pinInfo.map((p) => p.name).join(',')).toBe(pins);
    for (const p of el.pinInfo) {
      // The tips of the legs on the top edge: wires from the board above land
      // there without crossing the module.
      expect(p.y).toBe(0);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(width);
    }
    // Evenly spaced and centred, as on the plain module.
    const xs = el.pinInfo.map((p) => p.x);
    expect(xs[0] + xs[xs.length - 1]).toBeCloseTo(width);
  });

  it('paints a new state without redrawing the board', () => {
    const el = make('VCC,GND,DIN,CS,CLK', 'matrix');
    const svg = el.shadowRoot!.querySelector('svg');
    expect(litCells(el).some(Boolean)).toBe(false);
    el.moduleDisplay = { kind: 'matrix', rows: [0x80, 0, 0, 0, 0, 0, 0, 0x01], on: true };
    expect(el.shadowRoot!.querySelector('svg')).toBe(svg);
    const lit = litCells(el);
    expect(lit[0]).toBe(true); // top left
    expect(lit[63]).toBe(true); // bottom right
    expect(lit.filter(Boolean)).toHaveLength(2);
    el.moduleDisplay = { kind: 'matrix', rows: [0x80, 0, 0, 0, 0, 0, 0, 0x01], on: false };
    expect(litCells(el).some(Boolean)).toBe(false);
  });

  it('the catalogue places display cards with their blank display', () => {
    expect(cardMetadata(card('tm1637')).defaultValues).toMatchObject({ moduleDisplayKind: '7seg' });
    expect(cardMetadata(card('max7219-matrix')).defaultValues).toMatchObject({ moduleDisplayKind: 'matrix' });
  });
});
