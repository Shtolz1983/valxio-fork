import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boardPinLabel, wiringList, wiringText } from '../validation/wiringList';
import { cardKnowledge } from '../partsCatalog/catalog';
import { registerPartKnowledge } from '../validation/partsKnowledge';
import type { PartCard } from '../partsCatalog/types';

// The app registers card knowledge when the catalogue loads; it gives pin order and roles.
const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
for (const id of ['bme280', 'dht11']) {
  registerPartKnowledge(id, cardKnowledge(JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard));
}

let n = 0;
const wire = (a: string, b: string) => {
  const [ac, ap] = a.split(':');
  const [bc, bp] = b.split(':');
  return { id: `w${n++}`, start: { componentId: ac, pinName: ap }, end: { componentId: bc, pinName: bp } };
};
const LABELS = { notConnected: 'not connected', via: 'via' };
const NANO = { id: 'nano', boardKind: 'arduino-nano' };

describe('circuit as text', () => {
  it('lists each part pin with the controller pin it reaches', () => {
    const parts = wiringList({
      boards: [NANO],
      components: [{ id: 'bme280_1', metadataId: 'bme280' }],
      wires: [
        wire('bme280_1:VIN', 'nano:5V'),
        wire('bme280_1:GND', 'nano:GND.2'),
        wire('bme280_1:SCL', 'nano:A5'),
        wire('bme280_1:SDA', 'nano:A4'),
      ],
      nameOf: () => 'BME280',
    });
    expect(wiringText(parts, LABELS)).toBe(
      ['BME280 (bme280_1)', '  VIN → 5V', '  GND → GND', '  SCL → A5  I2C SCL', '  SDA → A4  I2C SDA'].join('\n'),
    );
  });

  it('follows a series resistor and says so, and names unwired peers', () => {
    const parts = wiringList({
      boards: [NANO],
      components: [
        { id: 'led1', metadataId: 'led' },
        { id: 'r1', metadataId: 'resistor', properties: { value: '220' } },
        { id: 'btn', metadataId: 'pushbutton' },
        { id: 'led2', metadataId: 'led' },
      ],
      wires: [
        wire('nano:13', 'r1:1'),
        wire('r1:2', 'led1:A'),
        wire('led1:C', 'nano:GND.1'),
        wire('btn:1.l', 'led2:A'),
      ],
    });
    const text = wiringText(parts, LABELS);
    expect(text).toContain('led (led1)\n  A → D13 (via 220 Ω)\n  C → GND');
    expect(text).toContain('resistor (r1)\n  1 → D13\n  2 → led1:A');
    expect(text).toContain('pushbutton (btn)\n  1.l → led2:A');
    expect(text).toContain('led (led2)\n  A → btn:1.l');
  });

  it('names the board when there are several, and prints board pins as labelled', () => {
    const parts = wiringList({
      boards: [NANO, { id: 'esp', boardKind: 'esp32', name: 'ESP32' }],
      components: [{ id: 'm', metadataId: 'dht11' }],
      wires: [wire('m:DATA', 'esp:4'), wire('m:VCC', 'nano:5V')],
    });
    expect(parts[0].pins.map((p) => [p.pin, p.targets])).toEqual([
      ['VCC', [{ boardPin: '5V', board: 'nano' }]],
      ['DATA', [{ boardPin: 'GPIO4', board: 'ESP32' }]],
    ]);
    expect(boardPinLabel('arduino-uno', 'A4.2')).toBe('A4');
    expect(boardPinLabel('raspberry-pi-pico', 'GP4')).toBe('GP4');
  });

  it('leaves out parts with no wires', () => {
    expect(wiringList({ boards: [NANO], components: [{ id: 'x', metadataId: 'led' }], wires: [] })).toEqual([]);
  });
});
