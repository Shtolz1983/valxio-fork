// @vitest-environment jsdom
/**
 * The 3D-printable enclosure (store/useEnclosureStore.ts): a spec from the AI
 * assistant's build_enclosure call opens the viewer and is built with meshes;
 * when builds overlap only the latest one is shown.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../ai/tools', () => ({ runAiTool: vi.fn() }));

import { useAiStore } from '../store/useAiStore';
import { useEnclosureStore } from '../store/useEnclosureStore';

const built = (board: string) => ({ ok: true, violations: [], board: { id: board, name: board, verified: false }, spec: { board } });

/** fetch that answers each call when the test says so, in any order. */
function deferredFetch() {
  const calls: { url: string; body: unknown; answer: (payload: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      new Promise((resolve) => {
        calls.push({ url, body: JSON.parse(String(init?.body)), answer: (payload) => resolve(new Response(JSON.stringify(payload))) });
      }),
    ),
  );
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useEnclosureStore.setState({ spec: null, build: null, loading: false, error: null, open: false });
});

describe('enclosure store', () => {
  it('builds the spec with meshes and no render, and keeps only the latest build', async () => {
    const calls = deferredFetch();
    useEnclosureStore.getState().showSpec({ board: 'arduino_uno' });
    useEnclosureStore.getState().showSpec({ board: 'arduino_nano' });
    expect(useEnclosureStore.getState()).toMatchObject({ open: true, loading: true, spec: { board: 'arduino_nano' } });
    expect(calls[0].url).toBe('/api/enclosure/build');
    expect(calls[0].body).toEqual({ spec: { board: 'arduino_uno' }, render: false, meshes: true });

    calls[1].answer(built('arduino_nano'));
    await settle();
    calls[0].answer(built('arduino_uno'));
    await settle();
    expect(useEnclosureStore.getState()).toMatchObject({ loading: false, build: { board: { id: 'arduino_nano' } } });
  });

  it('a failed build reports the error and keeps the last good build to fix the spec from', async () => {
    const good = built('arduino_uno');
    useEnclosureStore.setState({ build: good as never });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'a battery on the left would cover the usb window' }), { status: 422 })));
    useEnclosureStore.getState().showSpec({ board: 'arduino_uno', battery: '2xAA', battery_side: 'left' });
    await settle();
    expect(useEnclosureStore.getState()).toMatchObject({ loading: false, error: 'a battery on the left would cover the usb window' });
    expect(useEnclosureStore.getState().build).toBe(good);
  });
});

describe('assistant → viewer', () => {
  class FakeSocket {
    static last: FakeSocket;
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    onmessage: ((e: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      FakeSocket.last = this;
    }
    send() {}
    close() {}
  }

  it('a successful build_enclosure call opens the viewer with its spec; a failed one does not', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    deferredFetch();
    useAiStore.getState().connect();
    const say = (msg: object) => FakeSocket.last.onmessage!({ data: JSON.stringify(msg) });

    say({ type: 'tool_use', id: 't1', name: 'build_enclosure', input: { board: 'uno' } });
    say({ type: 'tool_result', id: 't1', isError: true, preview: 'Error: unknown board' });
    expect(useEnclosureStore.getState().open).toBe(false);

    const spec = { board: 'arduino_uno', lid: 'snap', extras: [{ face: 'top', diameter: 5, center_x: 30, center_y: 25 }] };
    say({ type: 'tool_use', id: 't2', name: 'build_enclosure', input: spec });
    say({ type: 'tool_result', id: 't2', isError: false, preview: '{"ok": true}' });
    expect(useEnclosureStore.getState()).toMatchObject({ open: true, spec });
  });
});
