import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TOOL_IMAGES, runApiAgent, toolSet } from '../apiAgent.mjs';
import { backendError, buildEnclosure, listEnclosureBoards } from '../enclosure.mjs';
import { TOOLS } from '../tools.mjs';
import * as anthropic from '../providers/anthropic.mjs';
import * as openai from '../providers/openai.mjs';
import * as openaiChat from '../providers/openaiChat.mjs';

const PNG = 'iVBORw0KGgo=';

/** A stand-in for the Velxio backend's /api/enclosure routes; records the request bodies. */
async function fakeBackend(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const [status, payload] = handler(req.url);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

const BOARD = {
  id: 'arduino_uno',
  name: 'Arduino Uno R3',
  canvas_kinds: ['arduino-uno'],
  verified: false,
  notes: 'USB-B and DC jack on the left edge',
  size: [68.58, 53.34],
  top_height: 11,
  mount: 'standoffs',
  holes: { diameter: 3.2, positions: [[13.97, 2.54]] },
  connectors: [{ name: 'usb', type: 'usb_b', side: 'left', center: 37.96, z: 0, width: 12.08, height: 10.9, overhang: 6.2, depth: null }],
};

const BUILT = {
  ok: false,
  violations: [{ severity: 'error', check: 'thickness', message: 'wall=0.8 mm is below min_wall=1.2 mm' }],
  board: { id: 'arduino_uno', name: 'Arduino Uno R3', verified: false },
  outer: { x0: -4.7, y0: -3, x1: 71.58, y1: 56.34, z0: 0, z1: 22.1 },
  weight_g: 36.3,
  spec: {},
  render_png: PNG,
  base_stl: null,
  lid_stl: null,
};

test('boards come back with what the model needs to place openings', async () => {
  const battery = { id: '2xAA', length: 58, width: 32, height: 16, description: '2 x AA holder' };
  const module = { id: 'ds3231', name: 'ZS-042 DS3231 RTC module', part_types: ['ds3231'], size: [38, 22], top_height: 15, holes: null };
  const backend = await fakeBackend(() => [200, { boards: [BOARD], batteries: [battery], modules: [module] }]);
  try {
    const { boards: [b], batteries, modules } = await listEnclosureBoards(backend.url);
    assert.deepEqual(batteries, [battery]);
    assert.deepEqual(modules, [{ id: 'ds3231', name: 'ZS-042 DS3231 RTC module', partTypes: ['ds3231'], size: [38, 22], height: 15 }]);
    assert.equal(backend.seen[0].url, '/api/enclosure/boards');
    assert.deepEqual(b.canvasKinds, ['arduino-uno']);
    assert.deepEqual(b.connectors, [{ name: 'usb', type: 'usb_b', side: 'left', center: 37.96, z: 0 }]);
    assert.equal(b.holes, undefined);
  } finally {
    backend.close();
  }
});

test('a build sends the spec without meshes and returns the checks, with the render as an image', async () => {
  const backend = await fakeBackend(() => [200, BUILT]);
  try {
    const r = await buildEnclosure(backend.url, { board: 'arduino_uno', wall: 0.8 });
    assert.deepEqual(backend.seen[0], {
      method: 'POST',
      url: '/api/enclosure/build',
      body: { spec: { board: 'arduino_uno', wall: 0.8 }, render: true, meshes: false },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.outerSizeMm, [76.3, 59.3, 22.1]);
    assert.deepEqual(r[TOOL_IMAGES], [{ mediaType: 'image/png', data: PNG }]);
    // the picture never ends up in the text the model reads
    assert.ok(!JSON.stringify(r).includes(PNG));
  } finally {
    backend.close();
  }
});

test('backend errors become one sentence', async () => {
  assert.equal(backendError(404, { detail: "unknown board 'uno'" }), "unknown board 'uno'");
  assert.equal(
    backendError(422, { detail: [{ loc: ['body', 'spec', 'wall'], msg: 'Input should be a valid number' }] }),
    'spec.wall: Input should be a valid number',
  );
  assert.equal(backendError(422, { detail: { message: 'fails its checks', errors: ['[error] bed: too big'] } }), 'fails its checks; [error] bed: too big');
  assert.equal(backendError(502, {}), 'HTTP 502');
  const backend = await fakeBackend(() => [404, { detail: "unknown board 'uno'" }]);
  try {
    await assert.rejects(buildEnclosure(backend.url, { board: 'uno' }), /unknown board 'uno'/);
  } finally {
    backend.close();
  }
});

test('the build_enclosure schema takes a full spec and refuses a bad face', () => {
  const def = TOOLS.find((t) => t.name === 'build_enclosure');
  const [tool] = toolSet([{ ...def, execute: async () => ({}) }]);
  const spec = {
    board: 'arduino_uno',
    lid: 'snap',
    skip_connectors: ['power'],
    extras: [
      { name: 'led', face: 'top', shape: 'circle', diameter: 5, center_x: 30, center_y: 20 },
      { face: 'front', shape: 'slots', width: 2, height: 8, along: 34, z: 6, slot_count: 4 },
    ],
    modules: [{ name: 'rtc1', type: 'ds3231' }, { name: 'mp3', size: [21, 21], height: 8, position: [5, 60] }],
    bed: [220, 220, 250],
  };
  assert.ok(tool.check(spec).success);
  assert.ok(!tool.check({ board: 'arduino_uno', extras: [{ face: 'side' }] }).success);
});

test('every bridge tool is implemented in server.mjs', () => {
  const src = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('const BRIDGE_TOOLS'), src.indexOf('\n};', src.indexOf('const BRIDGE_TOOLS')));
  for (const t of TOOLS.filter((t) => t.where === 'bridge')) assert.match(body, new RegExp(`\\b${t.name}\\b`), t.name);
});

test('tool images reach the provider with the tool result', async () => {
  const sent = [];
  const provider = {
    userItems: (text) => [{ role: 'user', text }],
    toolResultItems: (results) => {
      sent.push(...results);
      return [];
    },
    turns: [{ toolCalls: [{ id: 't1', name: 'look', input: {} }], stop: 'tools' }, { stop: 'end' }],
    async turn() {
      const t = this.turns.shift();
      return { append: [], text: '', toolCalls: t.toolCalls ?? [], stop: t.stop };
    },
    describeError: (err) => err.message,
  };
  const sessions = { load: () => null, save() {} };
  const tools = toolSet([{ name: 'look', description: 'x', input: {}, execute: async () => ({ ok: true, [TOOL_IMAGES]: [{ mediaType: 'image/png', data: PNG }] }) }]);
  await runApiAgent({ provider, conn: { kind: 'anthropic', model: 'm' }, sessions, sessionId: null, prompt: 'p', tools, onEvent() {} }).done;
  assert.equal(sent[0].output, '{\n  "ok": true\n}');
  assert.deepEqual(sent[0].images, [{ mediaType: 'image/png', data: PNG }]);
});

test('each API kind gets the tool images in its own form', () => {
  const results = [
    { id: 't1', name: 'build_enclosure', output: '{}', isError: false, images: [{ mediaType: 'image/png', data: PNG }] },
    { id: 't2', name: 'get_project', output: '{}', isError: false, images: [] },
  ];
  const [msg] = anthropic.toolResultItems(results);
  assert.deepEqual(msg.content[0].content, [
    { type: 'text', text: '{}' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ]);
  assert.equal(msg.content[1].content, '{}');

  const [out1, out2] = openai.toolResultItems(results);
  assert.deepEqual(out1.output[1], { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' });
  assert.equal(out2.output, '{}');

  const chat = openaiChat.toolResultItems(results);
  assert.deepEqual(chat.map((m) => m.role), ['tool', 'tool', 'user']);
  assert.equal(chat[2].content[1].image_url.url, `data:image/png;base64,${PNG}`);
  assert.deepEqual(openaiChat.toolResultItems([results[1]]).map((m) => m.role), ['tool']);
});
