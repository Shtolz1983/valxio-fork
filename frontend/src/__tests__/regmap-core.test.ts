/**
 * The register-map engine (partsCatalog/regmap.ts) against the shared cases in
 * fixtures/regmap-vectors.json — the ESP32 worker's Python twin answers the
 * same file (backend/tests/test_catalog_regmap.py) — and its card checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RegmapChip, regmapBytes, regmapProblems, type RegmapSpec, type RegmapValue } from '../partsCatalog/regmap';

interface Op {
  w?: number[];
  r?: number;
  wn?: number[];
  rn?: number;
  spi?: number[];
  set?: Record<string, number>;
  expect?: number[];
}

const VECTORS = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'regmap-vectors.json'), 'utf8')) as {
  bytes: Array<{ value: RegmapValue; v: number; expect: number[] }>;
  chips: Array<{ name: string; spec: RegmapSpec; values: Record<string, number>; ops: Op[] }>;
};

describe('register map: shared vectors', () => {
  it.each(VECTORS.bytes.map((c) => [JSON.stringify(c.value), c.v, c] as const))('%s at %s', (_, __, c) => {
    expect(regmapBytes(c.value, c.v)).toEqual(c.expect);
  });

  it.each(VECTORS.chips.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const chip = new RegmapChip(c.spec);
    chip.values = { ...c.values };
    for (const op of c.ops) {
      if (op.set) chip.values = { ...chip.values, ...op.set };
      if (op.w) {
        chip.start(false);
        for (const b of op.w) chip.writeByte(b);
        chip.stop();
      }
      if (op.r !== undefined) {
        chip.start(true);
        const got = Array.from({ length: op.r }, () => chip.readByte());
        chip.stop();
        expect(got).toEqual(op.expect);
      }
      if (op.wn) {
        for (const b of op.wn) chip.writeByte(b);
        chip.stop();
      }
      if (op.rn !== undefined) {
        const got = Array.from({ length: op.rn }, () => chip.readByte());
        chip.stop();
        expect(got).toEqual(op.expect);
      }
      if (op.spi) {
        chip.select();
        const got = op.spi.map((b) => chip.transfer(b));
        chip.deselect();
        expect(got).toEqual(op.expect);
      }
    }
  });

  it('a bit-banged master reads the next byte ahead', () => {
    const chip = new RegmapChip({ bus: 'spi', pointer: 0, values: [{ reg: 0, from: 't', bytes: 2, scale: 4, shift: 3 }] });
    chip.values = { t: 25 };
    chip.select();
    expect(chip.peekMiso()).toBe(3);
    expect(chip.transfer(0)).toBe(3);
    expect(chip.peekMiso()).toBe(32);
  });
});

describe('register map: card checks', () => {
  const good: RegmapSpec = {
    bus: 'i2c',
    registers: { '0x0F': '0x33', '0x10': ['0x01', 2] },
    values: [{ reg: '0x00', from: 'temperature', bytes: 2, signed: true, scale: 2, shift: 7 }],
  };

  it('takes a well-formed map', () => {
    expect(regmapProblems(good, ['temperature'])).toEqual([]);
    expect(regmapProblems({ bus: 'spi', pointer: 0, values: [{ reg: 0, from: 't', points: [[0, 0], [1, 5]] }] }, ['t'])).toEqual([]);
  });

  it('names what is wrong', () => {
    const problems = (spec: unknown, keys = ['temperature']) => regmapProblems(spec, keys).join('\n');
    expect(problems(undefined)).toMatch(/missing/);
    expect(problems({ ...good, bus: 'uart' })).toMatch(/bus/);
    expect(problems({ ...good, pointer: 3 })).toMatch(/pointer/);
    expect(problems({ ...good, extra: 1 })).toMatch(/unknown field "extra"/);
    expect(problems({ ...good, registers: { '0x0F': '0x133' } })).toMatch(/bytes 0..255/);
    expect(problems({ ...good, registers: { zz: 1 } })).toMatch(/not a register address/);
    expect(problems({ ...good, values: [] })).toMatch(/at least one reading/);
    expect(problems({ ...good, values: [{ reg: 0, from: 'humidity' }] })).toMatch(/must name a control/);
    expect(problems({ ...good, values: [{ reg: 0, from: 'temperature', bytes: 5 }] })).toMatch(/bytes: 1..4/);
    expect(problems({ ...good, values: [{ reg: '0xFF', from: 'temperature', bytes: 2 }] })).toMatch(/reg: not a register/);
    expect(problems({ ...good, values: [{ reg: 0, from: 'temperature', shift: 8 }] })).toMatch(/shift/);
    expect(problems({ ...good, values: [{ reg: 0, from: 'temperature', points: [[1, 0], [0, 1]] }] })).toMatch(/values rising/);
    expect(problems({ ...good, values: [{ reg: 0, from: 'temperature', scale: 2, points: [[0, 0], [1, 1]] }] })).toMatch(/not both/);
    expect(problems({ ...good, readWhen: 2, readBit: 9, spiMode: 4 })).toMatch(/readWhen[\s\S]*|readBit|spiMode/);
  });
});
