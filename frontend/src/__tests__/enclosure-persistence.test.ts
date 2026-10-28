// @vitest-environment jsdom
/**
 * The enclosure travels with the project: its spec is in the .vlx and the
 * browser autosave and comes back with them, another project drops it, and
 * "Save project" into a folder adds the print files under enclosure/.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';

import type { EnclosureSpec } from '../services/enclosureService';
import { useEnclosureStore } from '../store/useEnclosureStore';
import { useProjectStore } from '../store/useProjectStore';
import { hasLocalAutosave, restoreLocalAutosave, startLocalAutosave } from '../utils/localAutosave';
import { findConflicts, planEnclosureFiles, type FolderTarget } from '../utils/projectFolder';
import { buildVlxPayload, importVlxFile } from '../utils/vlxFile';
import { useSimulatorStore } from '../store/useSimulatorStore';

const SPEC: EnclosureSpec = {
  board: 'arduino_uno',
  battery: '2xAA',
  extras: [{ name: 'oled1', face: 'top', shape: 'rect', width: 30, height: 15, center_x: 40, center_y: 30 }],
};

const vlxFile = (payload: object) => new File([JSON.stringify(payload)], 'station.vlx', { type: 'application/json' });

beforeEach(() => {
  localStorage.clear();
  useEnclosureStore.setState({ spec: null, build: null, loading: false, error: null, open: false });
  vi.unstubAllGlobals();
});

describe('enclosure in the .vlx', () => {
  it('is saved with the project, and left out when there is none', () => {
    expect(buildVlxPayload().enclosure).toBeUndefined();
    useEnclosureStore.setState({ spec: SPEC });
    expect(buildVlxPayload().enclosure).toEqual(SPEC);
  });

  it('comes back when the file opens, unbuilt until the viewer opens', async () => {
    useEnclosureStore.setState({ spec: SPEC });
    const payload = buildVlxPayload({ name: 'station' });
    useEnclosureStore.setState({ spec: null });
    await importVlxFile(vlxFile(payload));
    expect(useEnclosureStore.getState()).toMatchObject({ spec: SPEC, build: null, open: false });
  });

  it('a file without one, or with a broken one, opens without a case', async () => {
    useEnclosureStore.setState({ spec: SPEC });
    const payload = { ...buildVlxPayload(), enclosure: { battery: '2xAA' } };
    await importVlxFile(vlxFile(payload));
    expect(useEnclosureStore.getState().spec).toBeNull();
  });

  it('another project or a new workspace drops it', () => {
    useEnclosureStore.setState({ spec: SPEC });
    useProjectStore.getState().clearCurrentProject();
    expect(useEnclosureStore.getState().spec).toBeNull();
  });
});

describe('enclosure in the browser autosave', () => {
  it('is saved when it changes and restored on reload', () => {
    vi.useFakeTimers();
    useSimulatorStore.getState().addBoard('arduino-uno', 0, 0);
    const stop = startLocalAutosave();
    useEnclosureStore.setState({ spec: SPEC });
    vi.advanceTimersByTime(1500);
    stop();
    vi.useRealTimers();
    expect(hasLocalAutosave()).toBe(true);

    useEnclosureStore.setState({ spec: null });
    expect(restoreLocalAutosave()).toBe(true);
    expect(useEnclosureStore.getState().spec).toEqual(SPEC);
  });
});

describe('enclosure print files in a saved project folder', () => {
  async function exportZip() {
    const zip = new JSZip();
    zip.file('base.stl', new Uint8Array([1, 2, 3]));
    zip.file('lid.stl', new Uint8Array([4, 5]));
    zip.file('base.step', 'ISO-10303-21;');
    zip.file('lid.step', 'ISO-10303-21;');
    zip.file('spec.json', '{}');
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  it('come from the export zip, without its spec.json', async () => {
    const zip = await exportZip();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(zip));
    vi.stubGlobal('fetch', fetchMock);
    const { files, error } = await planEnclosureFiles(SPEC);
    expect(error).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ spec: SPEC });
    expect(files.map((f) => f.path.join('/'))).toEqual(['enclosure/base.stl', 'enclosure/lid.stl', 'enclosure/base.step', 'enclosure/lid.step']);
    expect([...(files[0].content as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it('a case that fails its checks gives the reason instead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: { message: 'the enclosure fails its checks', errors: ['[error] bed: too big'] } }), { status: 422 })),
    );
    expect(await planEnclosureFiles(SPEC)).toEqual({ files: [], error: 'the enclosure fails its checks; [error] bed: too big' });
    expect(await planEnclosureFiles(null)).toEqual({ files: [] });
  });

  it('a binary file already there with the same bytes is no conflict, other bytes are', async () => {
    const stored = new Map<string, Uint8Array>([['base.stl', new Uint8Array([1, 2, 3])]]);
    const enclosureDir = {
      getFileHandle: async (name: string) => {
        if (!stored.has(name)) throw new DOMException('not found', 'NotFoundError');
        return { getFile: async () => ({ arrayBuffer: async () => stored.get(name)!.buffer }) };
      },
    };
    const root = {
      name: 'station',
      getDirectoryHandle: async (name: string) => {
        if (name !== 'enclosure') throw new DOMException('not found', 'NotFoundError');
        return enclosureDir;
      },
      getFileHandle: async () => {
        throw new DOMException('not found', 'NotFoundError');
      },
    };
    const target = { picked: root as unknown as FileSystemDirectoryHandle, sub: null } as FolderTarget;
    const same = [{ path: ['enclosure', 'base.stl'], content: new Uint8Array([1, 2, 3]) }];
    const changed = [{ path: ['enclosure', 'base.stl'], content: new Uint8Array([1, 2, 4]) }];
    expect(await findConflicts(target, same)).toEqual([]);
    expect(await findConflicts(target, changed)).toEqual([{ path: 'enclosure/base.stl' }]);
  });
});
