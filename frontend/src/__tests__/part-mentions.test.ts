/**
 * "$" mentions in the AI chat (ai/partMentions.ts): which parts the list
 * offers, how a query ranks them (Russian titles too), and how `$[type]` is
 * read back out of a message.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/ComponentRegistry', () => {
  const parts = [
    { id: 'arduino-uno', name: 'Arduino Uno', category: 'boards', tags: [] },
    { id: 'led-ring', name: 'LED Ring', category: 'output', tags: [] },
    { id: 'led', name: 'LED', category: 'output', tags: ['light'] },
    { id: 'dht22', name: 'DHT22 Sensor', category: 'sensors', tags: ['temperature'] },
    { id: 'bme280', name: 'BME280 module', category: 'sensors', tags: [] },
    { id: 'instr-voltmeter', name: 'Voltmeter', category: 'other', tags: [] },
  ];
  return { default: { getAllComponents: () => parts, getById: (id: string) => parts.find((p) => p.id === id) } };
});

import { mentionLabel, mentionParts, searchMentionParts, splitMentions } from '../ai/partMentions';
import type { PartCard } from '../partsCatalog/types';

const cards = [
  { id: 'dht22', name: 'DHT22', title: 'Temperature and humidity', titleRu: 'Температура и влажность', component: 'dht22', interface: 'single-wire' },
  { id: 'bme280', name: 'BME280', title: 'Pressure, temperature, humidity', titleRu: 'Давление, температура, влажность', interface: 'i2c' },
] as unknown as PartCard[];

describe('$ part mentions', () => {
  it('lists parts without boards and instruments, catalogue cards first', () => {
    expect(mentionParts(cards).map((p) => p.type)).toEqual(['dht22', 'bme280', 'led-ring', 'led']);
  });

  it('finds parts by name, by Russian title and by interface', () => {
    const parts = mentionParts(cards);
    expect(searchMentionParts(parts, 'dh').map((p) => p.type)).toEqual(['dht22']);
    // The exact name first, then names that start with it.
    expect(searchMentionParts(parts, 'led').map((p) => p.type)).toEqual(['led', 'led-ring']);
    expect(searchMentionParts(parts, 'давлен').map((p) => p.type)).toEqual(['bme280']);
    expect(searchMentionParts(parts, 'влажн').map((p) => p.type)).toEqual(['dht22', 'bme280']);
    expect(searchMentionParts(parts, 'i2c').map((p) => p.type)).toEqual(['bme280']);
    // Every word has to match.
    expect(searchMentionParts(parts, 'led температура')).toEqual([]);
  });

  it('reads $[type] back out of a message and names it', () => {
    expect(splitMentions('Подключи $[dht22] и $[led] к D2')).toEqual(['Подключи ', { type: 'dht22' }, ' и ', { type: 'led' }, ' к D2']);
    expect(splitMentions('costs $5 [no]')).toEqual(['costs $5 [no]']);
    expect(mentionLabel('dht22', cards)).toBe('DHT22');
    expect(mentionLabel('led', cards)).toBe('LED');
    expect(mentionLabel('gone', cards)).toBe('gone');
  });
});
