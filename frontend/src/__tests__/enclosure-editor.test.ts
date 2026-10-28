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
  spec: {
    board: 'arduino_uno',
    lid: 'screw',
    skip_connectors: [],
    battery: null,
    battery_side: 'right',
    top_height: null,
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
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSimulatorStore.setState({ components: [{ id: 'bme1', metadataId: 'bme280', x: 0, y: 0, properties: {} }] as never });
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
    expect([...bme.querySelectorAll('input')].map((i) => i.value)).toEqual(['10', '4']);
    expect(vents.querySelectorAll('input')).toHaveLength(4); // width, height, count, pitch
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
    expect(host.textContent).toContain('Every size must be above zero.');
    act(() => button('Undo changes')!.click());
    expect(button('Rebuild')).toBeUndefined();
  });

  it('a battery and its end, or another board with the height of its parts, go into the spec', () => {
    const onApply = vi.fn();
    act(() => root.render(createElement(EnclosureEditor, { build: BUILD, catalog: CATALOG, busy: false, onApply })));
    act(() => choose(field('Battery'), '2xAA'));
    act(() => choose(field('Battery at the'), 'left'));
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[0][0]).toMatchObject({ battery: '2xAA', battery_side: 'left', board: 'arduino_uno' });

    act(() => choose(field('Board'), 'perfboard_50x70'));
    expect(field('Parts above the board').placeholder).toBe('12');
    act(() => type(field('Parts above the board'), '17'));
    // the built board's connector windows no longer apply
    expect(rows().map((r) => r.textContent)).not.toContain(expect.stringContaining('usb'));
    expect(host.textContent).toContain('appear after a rebuild');
    act(() => button('Rebuild')!.click());
    expect(onApply.mock.calls[1][0]).toMatchObject({ board: 'perfboard_50x70', top_height: 17, skip_connectors: [] });
  });
});
