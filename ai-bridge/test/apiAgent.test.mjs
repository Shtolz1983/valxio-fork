import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { runApiAgent, toolSet } from '../apiAgent.mjs';
import { ApiSessions } from '../apiSessions.mjs';
import { KeyStore } from '../keyStore.mjs';

const home = () => mkdtempSync(path.join(os.tmpdir(), 'velxio-api-test-'));

/** A provider that plays back scripted turns and records what it was sent. */
function scripted(turns) {
  const seen = [];
  return {
    seen,
    userItems: (text) => [{ role: 'user', text }],
    toolResultItems: (results) => results.map((r) => ({ role: 'tool', id: r.id, output: r.output, isError: r.isError })),
    async turn({ items, tools, onText }) {
      seen.push({ items: structuredClone(items), tools });
      const t = turns.shift();
      if (t.text) onText(t.text);
      return { append: [{ role: 'assistant', text: t.text ?? '', calls: t.toolCalls ?? [] }], text: t.text ?? '', toolCalls: t.toolCalls ?? [], stop: t.stop };
    },
    async listModels() {
      return [];
    },
    describeError: (err) => `described: ${err.message}`,
  };
}

const conn = { id: 'c1', kind: 'anthropic', model: 'm' };

function collect() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

test('the loop runs tools, feeds results back, and continues a saved session', async () => {
  const sessions = new ApiSessions(home());
  const ran = [];
  const tools = toolSet([
    { name: 'get_pins', description: 'pins', input: { type: z.string() }, execute: async ({ type }) => { ran.push(type); return { pins: ['VCC'] }; } },
  ]);
  const provider = scripted([
    { toolCalls: [{ id: 't1', name: 'get_pins', input: { type: 'dht22' } }, { id: 't2', name: 'get_pins', input: { type: 5 } }], stop: 'tools' },
    { text: 'Done.', stop: 'end' },
    { text: 'Still here.', stop: 'end' },
  ]);
  const a = collect();
  await runApiAgent({ provider, conn, sessions, sessionId: null, prompt: 'wire it', tools, onEvent: a.onEvent }).done;
  assert.deepEqual(ran, ['dht22']);
  const types = a.events.map((e) => e.type);
  assert.deepEqual(types, ['session', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text_delta', 'assistant_text', 'result']);
  const bad = a.events.filter((e) => e.type === 'tool_result')[1];
  assert.equal(bad.isError, true);
  assert.match(bad.preview, /do not match the tool/);
  assert.equal(provider.seen[0].tools[0].schema.properties.type.type, 'string');
  assert.equal(provider.seen[0].tools[0].schema.$schema, undefined);
  const sessionId = a.events[0].sessionId;
  assert.equal(a.events.at(-1).isError, false);
  assert.equal(a.events.at(-1).text, 'Done.');

  const b = collect();
  await runApiAgent({ provider, conn, sessions, sessionId, prompt: 'again', tools, onEvent: b.onEvent }).done;
  const history = provider.seen[2].items;
  assert.deepEqual(history.map((i) => i.role), ['user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
  assert.equal(history.at(-1).text, 'again');
  assert.equal(b.events[0].sessionId, sessionId);
});

test('an unknown or foreign session is reported lost, as claude --resume does', async () => {
  const sessions = new ApiSessions(home());
  const a = collect();
  await runApiAgent({ provider: scripted([]), conn, sessions, sessionId: '3f0c2a1e-1111-4222-8333-944455556666', prompt: 'x', onEvent: a.onEvent }).done;
  assert.deepEqual(a.events, [{ type: 'result', isError: true, sessionLost: true, text: '', numTurns: 0 }]);
});

test('a failed request becomes an error line and a failed result', async () => {
  const provider = scripted([]);
  provider.turn = async () => {
    throw new Error('401');
  };
  const a = collect();
  await runApiAgent({ provider, conn, sessions: new ApiSessions(home()), sessionId: null, prompt: 'x', onEvent: a.onEvent }).done;
  assert.deepEqual(a.events.slice(1).map((e) => [e.type, e.message ?? e.isError]), [['error', 'described: 401'], ['result', true]]);
});

test('stop cancels between tool calls', async () => {
  const provider = scripted([{ toolCalls: [{ id: 't1', name: 'slow', input: {} }, { id: 't2', name: 'slow', input: {} }], stop: 'tools' }]);
  let run;
  const tools = toolSet([{ name: 'slow', description: '', input: {}, execute: async () => run.child.kill() }]);
  const a = collect();
  run = runApiAgent({ provider, conn, sessions: new ApiSessions(home()), sessionId: null, prompt: 'x', tools, onEvent: a.onEvent });
  await run.done;
  const results = a.events.filter((e) => e.type === 'tool_result');
  assert.equal(results[1].isError, true);
  assert.match(results[1].preview, /Stopped/);
});

test('sessions are private files', async () => {
  const h = home();
  const s = new ApiSessions(h);
  s.save('3f0c2a1e-1111-4222-8333-944455556666', { kind: 'anthropic', items: [] });
  assert.equal(statSync(path.join(h, 'sessions', '3f0c2a1e-1111-4222-8333-944455556666.json')).mode & 0o777, 0o600);
  assert.throws(() => s.save('../x', { items: [] }), /bad session id/);
});

test('keys: file backend keeps them private and refuses odd input', async () => {
  const h = home();
  const k = new KeyStore({ home: h, backend: 'file' });
  await k.set('c1', 'sk-test-0123456789');
  assert.equal(await k.get('c1'), 'sk-test-0123456789');
  assert.equal(statSync(path.join(h, 'api-keys.json')).mode & 0o777, 0o600);
  await assert.rejects(k.set('c1', 'has space in it'), /API key/);
  await assert.rejects(k.set('c1', 'quote"inside1'), /API key/);
  await k.delete('c1');
  assert.equal(await k.get('c1'), null);
});

// ── The Anthropic adapter against a local stand-in of the streaming API ─────

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const usage = { input_tokens: 10, output_tokens: 5 };
const start = (id) => ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage } }];

const TOOL_TURN = sse([
  start('msg_1'),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_pins', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"type": "dh' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 't22"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
  ['message_stop', { type: 'message_stop' }],
]);
const TEXT_TURN = sse([
  start('msg_2'),
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DATA goes ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'to D4.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
  ['message_stop', { type: 'message_stop' }],
]);

test('the Anthropic adapter streams text, runs a tool call and sends its result back', async () => {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    // SDK 1.x sends the key as a bearer token; older ones as x-api-key.
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '');
    if (key !== 'sk-ant-test-key') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    bodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(bodies.length === 1 ? TOOL_TURN : TEXT_TURN);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const provider = await import('../providers/anthropic.mjs');
    const tools = toolSet([{ name: 'get_pins', description: 'pins', input: { type: z.string() }, execute: async () => ({ pins: ['VCC', 'DATA'] }) }]);
    const a = collect();
    await runApiAgent({ provider, conn: { ...conn, model: 'claude-opus-5-5' }, apiKey: 'sk-ant-test-key', system: 'sys', sessions: new ApiSessions(home()), sessionId: null, prompt: 'wire a DHT22', tools, onEvent: a.onEvent }).done;
    assert.deepEqual(a.events.map((e) => e.type + (e.message ? `:${e.message}` : '')), ['session', 'tool_use', 'tool_result', 'text_delta', 'text_delta', 'assistant_text', 'result']);
    assert.deepEqual(a.events[1].input, { type: 'dht22' });
    assert.equal(a.events.at(-1).text, 'DATA goes to D4.');
    // The first request: tools streamed eagerly, the refusal fallback on for this model.
    assert.equal(bodies[0].tools[0].eager_input_streaming, true);
    assert.equal(bodies[0].fallbacks, 'default');
    assert.equal(bodies[0].system, 'sys');
    // The second carries the tool_use turn and its result in one user message.
    const msgs = bodies[1].messages;
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(msgs[2].content[0].type, 'tool_result');
    assert.equal(msgs[2].content[0].tool_use_id, 'toolu_1');

    const b = collect();
    await runApiAgent({ provider, conn, apiKey: 'wrong-key-0000', system: 's', sessions: new ApiSessions(home()), sessionId: null, prompt: 'x', onEvent: b.onEvent }).done;
    assert.equal(b.events.find((e) => e.type === 'error').message, 'Anthropic rejected the API key.');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});
