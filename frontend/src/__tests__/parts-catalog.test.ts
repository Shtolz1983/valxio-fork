// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { planPins, fillExample, pinLiteral } from '../partsCatalog/autoWire';
import { cardKnowledge, cardMetadata } from '../partsCatalog/catalog';
import type { PartCard } from '../partsCatalog/types';

const CATALOG = path.resolve(__dirname, '../../../parts-catalog');
const card = (id: string) => JSON.parse(readFileSync(path.join(CATALOG, `${id}.json`), 'utf8')) as PartCard;

const UNO_PINS = [
  ...Array.from({ length: 14 }, (_, i) => String(i)),
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A4.2', 'A5.2',
  'GND.1', 'GND.2', '5V', '3.3V', 'VIN', 'AREF', 'IOREF', 'RESET',
];
const ESP32_PINS = [
  'EN', 'VN', 'VP', '34', '35', '32', '33', '25', '26', '27', '14', '12', '13', 'GND', 'VIN',
  '3V3', 'GND2', '15', '2', '4', 'RX2', '16', 'TX2', '17', '5', '18', '19', '21', 'RX0', 'TX0', '22', '23',
];

describe('parts catalogue cards', () => {
  it('every card file loads with the fields the editor reads', () => {
    for (const file of readdirSync(CATALOG).filter((f) => f.endsWith('.json'))) {
      const c = JSON.parse(readFileSync(path.join(CATALOG, file), 'utf8')) as PartCard;
      expect(c.id + '.json').toBe(file);
      expect(c.pins.length).toBeGreaterThan(1);
      expect(c.example).toMatch(/void setup\(/);
    }
  });

  it('turns a card into validator knowledge', () => {
    const k = cardKnowledge(card('bme280'));
    expect(k.pins).toMatchObject({ SDA: 'i2c-sda', SCL: 'i2c-scl', VIN: 'power', GND: 'ground' });
    expect(k.i2c?.addresses).toEqual([0x76, 0x77]);
    expect(k.required).toEqual(['SCL', 'SDA']);
    // A one-signal module needs that signal wired.
    expect(cardKnowledge(card('ds18b20')).required).toEqual(['DQ']);
    expect(cardKnowledge(card('ds18b20')).notes?.join(' ')).toMatch(/4700 Ω pull-up/);
  });

  it('describes a generic module for the component registry', () => {
    const m = cardMetadata(card('vl53l0x'));
    expect(m.tagName).toBe('velxio-sensor-module');
    expect(m.defaultValues.modulePins).toBe('VIN,GND,SCL,SDA,XSHUT');
    expect(m.category).toBe('sensors');
  });
});

describe('auto-wiring plan', () => {
  it('I2C on the Uno goes to A4/A5, power by the supply range', () => {
    const plan = planPins(card('bme280'), 'arduino-uno', UNO_PINS, new Set());
    expect(plan.assignment.SDA.boardPin).toBe('A4');
    expect(plan.assignment.SCL.boardPin).toBe('A5');
    expect(plan.assignment.VIN.boardPin).toBe('5V');
    expect(plan.assignment.GND.boardPin).toBe('GND.1');
    expect(plan.warnings).toEqual([]);
  });

  it('signals take free digital pins, skipping serial and pins already wired', () => {
    const plan = planPins(card('hc-sr04'), 'arduino-uno', UNO_PINS, new Set([2]));
    expect(plan.assignment.TRIG.boardPin).toBe('3');
    expect(plan.assignment.ECHO.boardPin).toBe('4');
  });

  it('on an ESP32: 3.3 V parts on 3V3, analog on ADC1, no strapping pins, 5 V parts warned', () => {
    const soil = planPins(card('soil-moisture'), 'esp32', ESP32_PINS, new Set());
    expect(soil.assignment.VCC.boardPin).toBe('3V3');
    expect([32, 33, 34, 35, 36, 39]).toContain(soil.assignment.AOUT.gpio);
    const sonar = planPins(card('hc-sr04'), 'esp32', ESP32_PINS, new Set());
    expect(sonar.assignment.VCC.boardPin).toBe('VIN');
    expect([0, 2, 12, 1, 3]).not.toContain(sonar.assignment.TRIG.gpio);
    expect(sonar.warnings.join(' ')).toMatch(/divider/);
    const rfid = planPins(card('rc522'), 'esp32', ESP32_PINS, new Set());
    expect(rfid.assignment.SCK.boardPin).toBe('18');
    expect(rfid.assignment.SDA.boardPin).toBe('5');
    expect(rfid.assignment['3V3'].boardPin).toBe('3V3');
  });

  it('fills the example with the planned pins', () => {
    const c = card('soil-moisture');
    const plan = planPins(c, 'arduino-uno', UNO_PINS, new Set());
    expect(fillExample(c, 'arduino-uno', plan)).toMatch(/SENSOR_PIN = A0;/);
    expect(pinLiteral('arduino-mega', 55)).toBe('A1');
    expect(pinLiteral('esp32', 34)).toBe('34');
  });

  it('refuses boards it has no pin knowledge for', () => {
    expect(() => planPins(card('ds18b20'), 'raspberry-pi-4', [], new Set())).toThrow(/Auto-wiring knows/);
  });
});
