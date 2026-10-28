// @vitest-environment jsdom
/**
 * get_enclosure (ai/tools.ts): the assistant changes an existing case from what
 * the project has now — the user's own edits from the enclosure dialog included —
 * and learns where an opening can go on each wall.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { runAiTool } from '../ai/tools';
import type { EnclosureBuild, EnclosureSpec } from '../services/enclosureService';
import { useEnclosureStore } from '../store/useEnclosureStore';

const FACES = {
  left: { along: [-1, 54.34], z: [-4.6, 13.9] },
  right: { along: [-1, 54.34], z: [-4.6, 13.9] },
  front: { along: [-8.7, 69.58], z: [-4.6, 13.9] },
  back: { along: [-8.7, 69.58], z: [-4.6, 13.9] },
  top: { x: [-8.7, 69.58], y: [-1, 54.34] },
  bottom: { x: [-8.7, 69.58], y: [-1, 54.34] },
};

/** The user rebuilt the assistant's case with a bigger display window. */
const SPEC: EnclosureSpec = {
  board: 'arduino_uno',
  lid: 'screw',
  skip_connectors: ['power'],
  extras: [{ name: 'oled1', face: 'top', shape: 'rect', width: 30, height: 15, center_x: 40, center_y: 30 }],
};

const BUILD = {
  ok: true,
  violations: [],
  outer: { x0: -10.7, y0: -3, x1: 71.58, y1: 56.34, z0: 0, z1: 22.1 },
  connectors: [{ name: 'usb', type: 'usb_b', side: 'left', window: { width: 13.08, height: 11.9 } }],
  faces: FACES,
  spec: SPEC,
} as unknown as EnclosureBuild;

beforeEach(() => {
  useEnclosureStore.setState({ spec: null, build: null, loading: false, error: null, open: false });
});

describe('get_enclosure', () => {
  it('says there is no case yet', async () => {
    expect(await runAiTool('get_enclosure', {})).toMatchObject({ exists: false });
  });

  it('returns the current spec with the user’s edits, the checks and where openings can go', async () => {
    useEnclosureStore.setState({ spec: SPEC, build: BUILD });
    const r = (await runAiTool('get_enclosure', {})) as Record<string, unknown>;
    expect(r).toMatchObject({ exists: true, spec: SPEC, builtFromThisSpec: true, ok: true, outerSizeMm: [82.3, 59.3, 22.1], faces: FACES });
    expect(r.lastBuildError).toBeUndefined();
  });

  it('a spec the backend refused comes back with its error, next to the last good build', async () => {
    const refused: EnclosureSpec = { ...SPEC, battery: '2xAA', battery_side: 'left' };
    useEnclosureStore.setState({ spec: refused, build: BUILD, error: 'a battery on the left would cover the usb window' });
    const r = (await runAiTool('get_enclosure', {})) as Record<string, unknown>;
    expect(r).toMatchObject({ spec: refused, builtFromThisSpec: false, lastBuildError: 'a battery on the left would cover the usb window' });
  });
});
