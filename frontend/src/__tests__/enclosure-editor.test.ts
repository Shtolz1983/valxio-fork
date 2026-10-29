// @vitest-environment jsdom
/**
 * The spec editor of the enclosure dialog (components/enclosure/EnclosureEditor.tsx):
 * every opening shows the part it is for and its sizes; changed sizes, connector
 * windows, the board and the battery go back as a new spec only on "Rebuild".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? '')),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../services/ComponentRegistry', () => ({
  default: { getById: (id: string) => (id === 'bme280' ? { name: 'BME280' } : undefined) },
}));

import { EnclosureEditor } from '../components/enclosure/EnclosureEditor';
import type { EnclosureBuild, EnclosureCatalog } from '../services/enclosureService';
import { useSimulatorStore } from '../store/useSimulatorStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILD = {
  connectors: [{ name: 'usb', type: 'usb_b', side: 'left', window: { width: 13.08, height: 11.9 } }],
  modules: [],
  lid_modules: [],
  faces: {
    left: { along: [-1, 54.3], z: [-4.6, 11.5] },
    right: { along: [-1, 54.3], z: [-4.6, 11.5] },
    front: { along: [-8.7, 69.6], z: [-4.6, 11.5] },
    back: { along: [-8.7, 69.6], z: [-4.6, 11.5] },
    top: { x: [-8.7, 69.6], y: [-1, 54.3] },
    bottom: { x: [-8.7, 69.6], y: [-1, 54.3] },
  },
  spec: {
    board: 'arduino_uno',
    lid: 'screw',
    skip_connectors: [],
    battery: null,
    battery_side: 'right',
    battery_hatch: false,
    top_height: null,
    modules: [],
    lid_modules: [],
    extras: [
      { name: 'bme1', face: 'front', shape: 'rect', width: 10, height: 4, along: 20, z: 3 },
      { name: 'vents', face: 'top', shape: 'slots', width: 2, height: 6, slot_count: 5, slot_pitch: 4, center_x: 30, center_y: 20 },
    ],
  },
} as unknown as EnclosureBuild;

const CATALOG: EnclosureCatalog = {
  boards: [
    { id: 'arduino_uno', name: 'Arduino Uno R3', canvas_kinds: ['arduino-uno'], verified: false, top_height: 11 },
    { id: 'perfboard_50x70', name: 'Prototype board 50 x 70 mm', canvas_kinds: [], verified: false, top_height: 12 },
  ],
  batteries: [{ id: '2xAA', length: 58, width: 32, height: 16, description: '2 x AA holder' }],
  modules: [
    { id: 'ds3231', name: 'ZS-042 DS3231 RTC module', part_types: ['ds3231'], size: [38, 22], top_height: 15 },
    { id: 'lcd1602', name: 'LCD1602 module', part_types: ['lcd1602'], size: [80, 36], top_height: 7.5, window: { center: [40, 18], size: [66, 17] } },
  ],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSimulatorStore.setState({
    components: [
      { id: 'bme1', metadataId: 'bme280', x: 0, y: 0, properties: {} },
      { id: 'rtc1', metadataId: 'ds3231', x: 0, y: 0, properties: {} },
      { id: 'lcd1', metadataId: 'lcd1602', x: 0, y: 0, properties: {} },
    ] as never,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const rows = () => [...host.querySelectorAll<HTMLElement>('.enc-opening')];
const field = (label: string) =>
  [...host.querySelectorAll<HTMLLabelElement>('.enc-field')].find((f) => f.textContent?.startsWith(label))!.querySelector<HTMLInputElement & HTMLSelectElement>('select, input')!;

function choose(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('enclosure openings', () => {
  it('names the part each opening is for, with its face, sizes and the connector windows', () => {
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply: vi.fn() })));
    const [usb, bme, vents] = rows();
    expect(usb.textContent).toContain('window 13.1 × 11.9 mm');
    expect(bme.textContent).toContain('bme1 · BME280');
    expect(bme.textContent).toContain('front wall');
    expect([...bme.querySelectorAll('input')].map((i) => i.value)).toEqual(['10', '4', '20', '3']); // sizes, then along and height
    expect(vents.querySelectorAll('input')).toHaveLength(6); // width, height, count, pitch, X, Y
    expect(button('Rebuild')).toBeUndefined();
  });

  it('sends changed sizes, a removed opening and a closed connector only on Rebuild', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    act(() => type(rows()[1].querySelector('input')!, '12'));
    act(() => rows()[2].querySelector<HTMLButtonElement>('.enc-opening-remove')!.click());
    act(() => rows()[0].querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    expect(onApply).not.toHaveBeenCalled();
    act(() => button('Rebuild')!.click());
    const spec = onApply.mock.calls[0][0];
    expect(spec.extras).toEqual([{ ...BUILD.spec.extras[0], width: 12 }]);
    expect(spec.skip_connectors).toEqual(['usb']);
    expect(spec.board).toBe('arduino_uno');
  });

  it('will not rebuild with an empty or zero size', () => {
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply: vi.fn() })));
    act(() => type(rows()[1].querySelector('input')!, ''));
    expect(button('Rebuild')!.disabled).toBe(true);
    expect(host.textContent).toContain('Every size must be above zero and every position filled in.');
    act(() => button('Undo changes')!.click());
    expect(button('Rebuild')).toBeUndefined();
  });

  it('a battery and its end, or another board with the height of its parts, go into the spec', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    act(() => choose(field('Battery'), '2xAA'));
    act(() => choose(field('Battery at the'), 'left'));
    const hatch = () => [...host.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent === 'Hatch in the bottom to change it');
    act(() => hatch()!.querySelector('input')!.click());
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[0][0]).toMatchObject({ battery: '2xAA', battery_side: 'left', battery_hatch: true, board: 'arduino_uno' });
    // no battery, no hatch
    act(() => choose(field('Battery'), ''));
    expect(hatch()).toBeUndefined();
    act(() => choose(field('Battery'), '2xAA'));
    expect(hatch()!.querySelector('input')!.checked).toBe(false);

    act(() => choose(field('Board'), 'perfboard_50x70'));
    expect(field('Parts above the board').placeholder).toBe('12');
    act(() => type(field('Parts above the board'), '17'));
    // the built board's connector windows no longer apply
    expect(rows().map((r) => r.textContent)).not.toContain(expect.stringContaining('usb'));
    expect(host.textContent).toContain('appear after a rebuild');
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[1][0]).toMatchObject({ board: 'perfboard_50x70', top_height: 17, skip_connectors: [] });
  });

  it('a gap to one wall goes into the spec; emptied, that wall takes the usual gap again', () => {
    const onApply = vi.fn();
    const build = { ...BUILD, spec: { ...BUILD.spec, clearance: 1, side_clearance: { front: 3 } } } as EnclosureBuild;
    act(() => root.render(createElement(EnclosureEditor, { build, catalog: CATALOG, busy: false, onApply })));
    const gaps = [...host.querySelectorAll<HTMLInputElement>('.enc-gaps input')];
    expect(gaps.map((g) => [g.value, g.placeholder])).toEqual([['', '1'], ['', '1'], ['3', '1'], ['', '1']]); // left, right, front, back
    act(() => type(gaps[1], '40'));
    act(() => type(gaps[2], ''));
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[0][0].side_clearance).toEqual({ right: 40 });
  });

  it('a part of the project with a module entry can be put inside the case and taken out again', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    expect(host.textContent).toContain('Only the board.');
    // bme1 has no module entry here, rtc1 has one
    expect([...field('Put inside').options].map((o) => o.value)).toEqual(['', 'rtc1']);
    act(() => choose(field('Put inside'), 'rtc1'));
    const rtc = rows().find((r) => r.textContent?.startsWith('rtc1'))!;
    expect(rtc.textContent).toContain('ZS-042 DS3231 RTC module · 38 × 22 × 15 mm');
    expect(rtc.textContent).toContain('placed after a rebuild');
    expect(host.querySelectorAll('.enc-field select').length).toBeGreaterThan(0);
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[0][0].modules).toEqual([{ name: 'rtc1', type: 'ds3231' }]);

    act(() => rtc.querySelector<HTMLButtonElement>('.enc-opening-remove')!.click());
    expect(host.textContent).toContain('Only the board.');
  });

  it('a display goes under the lid, not inside, and shows its window', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    expect([...field('Put inside').options].map((o) => o.value)).toEqual(['', 'rtc1']);
    expect([...field('Hang under the lid').options].map((o) => o.value)).toEqual(['', 'lcd1']);
    act(() => choose(field('Hang under the lid'), 'lcd1'));
    const lcd = rows().find((r) => r.textContent?.startsWith('lcd1'))!;
    expect(lcd.textContent).toContain('LCD1602 module · window 66 × 17 mm · placed after a rebuild');
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[0][0].lid_modules).toEqual([{ name: 'lcd1', type: 'lcd1602' }]);
  });

  it('moves an opening and adds a new one in the middle of the chosen face', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    // bme1 on the front wall: width, height, then along and height above the board
    const [, , along, z] = [...rows()[1].querySelectorAll('input')];
    expect(along.value).toBe('20');
    expect(along.title).toBe('from -8.7 to 69.6 mm');
    act(() => type(along, '35'));
    act(() => type(z, '5'));

    const selects = host.querySelectorAll<HTMLSelectElement>('.enc-add-opening select');
    act(() => choose(selects[0], 'left'));
    act(() => choose(selects[1], 'rect'));
    act(() => button('Add an opening')!.click());
    act(() => button('Rebuild')!.click());
    const { extras } = onApply.mock.calls[0][0];
    expect(extras[0]).toMatchObject({ name: 'bme1', along: 35, z: 5 });
    expect(extras[2]).toEqual({ name: 'hole1', face: 'left', shape: 'rect', width: 10, height: 4, along: 26.7, z: 3.5 });
  });
});
