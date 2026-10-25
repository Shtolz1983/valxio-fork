/**
 * Bill of materials from the canvas (utils/bom.ts): parts of one kind and
 * value are one row, instruments are left out, wires are counted.
 */
import { describe, it, expect } from 'vitest';

import { bomCsv, buildBom, type BomInput } from '../utils/bom';

const H = { qty: 'Qty', part: 'Part', value: 'Value', libraries: 'Libraries', ids: 'Ids', wires: 'Jumper wires' };

const circuit: BomInput = {
  boards: [
    { id: 'arduino-uno', boardKind: 'arduino-uno', name: 'My Uno' },
    { id: 'esp32', boardKind: 'esp32' },
  ],
  components: [
    { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'r2', metadataId: 'resistor', properties: { value: '4700' } },
    { id: 'r3', metadataId: 'resistor', properties: { value: '220' } },
    { id: 'led1', metadataId: 'led', properties: { color: 'red' } },
    { id: 'dht', metadataId: 'dht22', properties: {} },
    { id: 'vm', metadataId: 'instr-voltmeter', properties: {} },
  ],
  wires: [{}, {}, {}],
};

describe('bill of materials', () => {
  it('groups parts by kind and value and leaves instruments out', () => {
    const rows = buildBom(circuit);
    expect(rows.map((r) => [r.qty, r.value, r.ids.join(' ')])).toEqual([
      [1, '', 'arduino-uno'],
      [1, '', 'esp32'],
      [2, '220 Ω', 'r1 r3'],
      [1, '4.7 kΩ', 'r2'],
      [1, 'red', 'led1'],
      [1, '', 'dht'],
    ]);
    // A renamed board is still bought as its kind.
    expect(rows[0].part).not.toBe('My Uno');
    expect(rows.at(-1)!.libraries).toContain('DHT sensor library');
  });

  it('writes a CSV Excel opens with the names intact', () => {
    const csv = bomCsv(circuit, H);
    expect(csv.startsWith('﻿Qty,Part,Value,Libraries,Ids\r\n')).toBe(true);
    // The libraries cell holds a ";" and is quoted.
    expect(csv).toContain('"DHT sensor library; Adafruit Unified Sensor"');
    expect(csv.trimEnd().split('\r\n').at(-1)).toBe('3,Jumper wires,,,');
  });
});
