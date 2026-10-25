// The OpenAI-side adapters (providers/openai.mjs, providers/openaiChat.mjs)
// against a local HTTP server that speaks the wire formats the SDK parses:
// Responses API events (`event: <type>` + `data: <json>`) and Chat
// Completions chunks (`data: <json>` … `data: [DONE]`). Each run goes through
// runApiAgent, so the loop, the events and the stored items are the real ones.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { z } from 'zod';

import { runApiAgent, toolSet } from '../apiAgent.mjs';
import * as openai from '../providers/openai.mjs';
import * as openaiChat from '../providers/openaiChat.mjs';

/** A server that answers each POST with the next scripted reply and keeps the requests. */
async function fakeServer() {
  const s = { requests: [], replies: [], models: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    s.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    if (req.headers.authorization === 'Bearer bad') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/key')) {
      // OpenRouter's "who is this key" endpoint (a bad key got its 401 above).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { label: 'test key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: s.models }));
      return;
    }
    const reply = s.replies.shift();
    if (!reply) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no scripted reply' } }));
      return;
    }
    if (reply.status) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const frame of reply.frames) res.write(frame);
    if (reply.hang) return; // keep the stream open, as a slow model does
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  s.close = () => {
    server.closeAllConnections();
    server.close();
  };
  after(s.close);
  return s;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

/** Responses API stream: the given output items, text deltas for messages, then response.completed. */
function responsesReply(output, status = 'completed') {
  const frames = [sse('response.created', { response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] } })];
  output.forEach((item, i) => {
    frames.push(sse('response.output_item.added', { output_index: i, item: { ...item, status: 'in_progress' } }));
    if (item.type === 'message') {
      for (const part of item.content) {
        // Stream each text in two pieces, as a model does.
        const half = Math.ceil(part.text.length / 2);
        for (const delta of [part.text.slice(0, half), part.text.slice(half)]) {
          frames.push(sse('response.output_text.delta', { item_id: item.id, output_index: i, content_index: 0, delta, logprobs: [] }));
        }
      }
    }
    frames.push(sse('response.output_item.done', { output_index: i, item }));
  });
  const incomplete = status === 'incomplete' ? { reason: 'max_output_tokens' } : null;
  frames.push(sse(`response.${status}`, { response: { id: 'resp_1', object: 'response', status, output, incomplete_details: incomplete, error: null } }));
  return { frames };
}

const textMessage = (id, text) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

function memorySessions() {
  const store = new Map();
  return {
    store,
    load: (id) => (store.has(id) ? structuredClone(store.get(id)) : null),
    save: (id, s) => store.set(id, structuredClone(s)),
  };
}

function ledTools(calls) {
  return toolSet([
    {
      name: 'set_led',
      description: 'Turn an LED on',
      input: { pin: z.number() },
      execute: ({ pin }) => {
        calls.push(pin);
        return `LED on pin ${pin}`;
      },
    },
  ]);
}

async function run(opts) {
  const events = [];
  const handle = runApiAgent({ system: 'You are a test.', ...opts, onEvent: (e) => events.push(e) });
  if (opts.onStart) opts.onStart(handle, events);
  const { code } = await handle.done;
  return { code, events, sessionId: events.find((e) => e.type === 'session')?.sessionId };
}

// ── Responses API (kind 'openai') ───────────────────────────────────────────

test('openai: tool call → tool result → final text, then a second prompt carries the history', async () => {
  const s = await fakeServer();
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC-REASONING' };
  const call = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_A', name: 'set_led', arguments: '{"pin":13}' };
  s.replies.push(responsesReply([reasoning, call]));
  s.replies.push(responsesReply([textMessage('msg_1', 'The LED is on.')]));

  const conn = { kind: 'openai', baseUrl: s.baseURL, model: 'gpt-test' };
  const sessions = memorySessions();
  const pins = [];
  const first = await run({ provider: openai, conn, apiKey: 'sk-test', sessions, sessionId: null, prompt: 'light pin 13', images: [{ mediaType: 'image/png', data: 'AAAA' }], tools: ledTools(pins) });

  assert.equal(first.code, 0);
  assert.deepEqual(pins, [13]);
  const types = first.events.map((e) => e.type);
  assert.deepEqual(types, ['session', 'tool_use', 'tool_result', 'text_delta', 'text_delta', 'assistant_text', 'result']);
  assert.deepEqual(first.events[1], { type: 'tool_use', id: 'call_A', name: 'set_led', input: { pin: 13 } });
  assert.equal(first.events[2].isError, false);
  assert.equal(first.events.filter((e) => e.type === 'text_delta').map((e) => e.text).join(''), 'The LED is on.');
  assert.equal(first.events.at(-1).subtype, 'success');
  assert.equal(first.events.at(-1).text, 'The LED is on.');

  // The first request: stateless, encrypted reasoning asked for, function tools, the image as a data URL.
  const r1 = s.requests[0];
  assert.equal(r1.url, '/v1/responses');
  assert.equal(r1.auth, 'Bearer sk-test');
  assert.equal(r1.body.store, false);
  assert.equal(r1.body.stream, true);
  assert.deepEqual(r1.body.include, ['reasoning.encrypted_content']);
  assert.equal(r1.body.instructions, 'You are a test.');
  assert.equal(r1.body.tools[0].type, 'function');
  assert.equal(r1.body.tools[0].name, 'set_led');
  assert.equal(r1.body.tools[0].parameters.properties.pin.type, 'number');
  assert.deepEqual(r1.body.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' });

  // The second request carries the reasoning (encrypted, without its id) and the tool result.
  const r2 = s.requests[1].body.input;
  assert.deepEqual(r2.map((i) => i.type), ['message', 'reasoning', 'function_call', 'function_call_output']);
  assert.equal(r2[1].encrypted_content, 'ENC-REASONING');
  assert.ok(!('id' in r2[1]) && !('id' in r2[2]));
  assert.deepEqual(r2[3], { type: 'function_call_output', call_id: 'call_A', output: 'LED on pin 13' });

  // Stored items: the output items as returned (ids kept), plus the tool result.
  const saved = sessions.store.get(first.sessionId);
  assert.equal(saved.kind, 'openai');
  assert.deepEqual(saved.items.map((i) => i.type), ['message', 'reasoning', 'function_call', 'function_call_output', 'message']);
  assert.equal(saved.items[1].id, 'rs_1');

  // A second prompt in the same session sees the whole first exchange.
  s.replies.push(responsesReply([textMessage('msg_2', 'Pin 13.')]));
  const second = await run({ provider: openai, conn, apiKey: 'sk-test', sessions, sessionId: first.sessionId, prompt: 'which pin?', tools: ledTools(pins) });
  assert.equal(second.code, 0);
  assert.equal(second.sessionId, first.sessionId);
  const r3 = s.requests[2].body.input;
  assert.equal(r3.length, 6);
  assert.deepEqual(r3.at(-1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'which pin?' }] });
  assert.equal(r3[4].content[0].text, 'The LED is on.');
});

test('openai: web search adds the built-in tool; max_output_tokens maps to max_tokens', async () => {
  const s = await fakeServer();
  s.replies.push(responsesReply([textMessage('msg_1', 'Partial')], 'incomplete'));
  const r = await openai.turn({ conn: { kind: 'openai', baseUrl: s.baseURL }, apiKey: 'k', model: 'gpt-test', system: '', items: openai.userItems('hi'), tools: [], webSearch: true, onText: () => {} });
  assert.deepEqual(s.requests[0].body.tools, [{ type: 'web_search' }]);
  assert.equal(r.stop, 'max_tokens');
  assert.equal(r.text, 'Partial');
});

test('openai: a 401 becomes "the API key was rejected"', async () => {
  const s = await fakeServer();
  const { code, events } = await run({ provider: openai, conn: { kind: 'openai', baseUrl: s.baseURL, model: 'gpt-test' }, apiKey: 'bad', sessions: memorySessions(), sessionId: null, prompt: 'hi' });
  assert.equal(code, 1);
  assert.deepEqual(events.find((e) => e.type === 'error'), { type: 'error', message: 'The API key was rejected.' });
});

test('openai: listModels keeps the chat models, newest first', async () => {
  const s = await fakeServer();
  s.models = [
    { id: 'gpt-4o', created: 2, object: 'model', owned_by: 'openai' },
    { id: 'text-embedding-3-small', created: 9, object: 'model', owned_by: 'openai' },
    { id: 'gpt-4o-mini-tts', created: 9, object: 'model', owned_by: 'openai' },
    { id: 'whisper-1', created: 9, object: 'model', owned_by: 'openai' },
    { id: 'gpt-image-1', created: 9, object: 'model', owned_by: 'openai' },
    { id: 'omni-moderation-latest', created: 9, object: 'model', owned_by: 'openai' },
    { id: 'o3', created: 5, object: 'model', owned_by: 'openai' },
    { id: 'gpt-realtime', created: 9, object: 'model', owned_by: 'openai' },
  ];
  assert.deepEqual(await openai.listModels({ conn: { kind: 'openai', baseUrl: s.baseURL }, apiKey: 'k' }), [
    { id: 'o3', label: 'o3' },
    { id: 'gpt-4o', label: 'gpt-4o' },
  ]);
});

// ── Chat Completions (OpenRouter, OpenAI-compatible, Ollama) ───────────────

test('chat: streamed tool call fragments → tool result → final text; history reused next prompt', async () => {
  const s = await fakeServer();
  // Turn 1: some text, then a tool call whose arguments arrive in pieces.
  s.replies.push({
    frames: [
      chunk({ role: 'assistant', content: 'Let me ' }),
      chunk({ content: 'turn it on.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { name: 'set_led', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pi' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'n": 7}' } }] }),
      chunk({}, 'tool_calls'),
      DONE,
    ],
  });
  s.replies.push({ frames: [chunk({ role: 'assistant', content: 'Done' }), chunk({ content: '.' }), chunk({}, 'stop'), DONE] });

  const conn = { kind: 'openai-compatible', baseUrl: s.baseURL, model: 'local-model' };
  const sessions = memorySessions();
  const pins = [];
  const first = await run({ provider: openaiChat, conn, apiKey: '', sessions, sessionId: null, prompt: 'light pin 7', tools: ledTools(pins) });

  assert.equal(first.code, 0);
  assert.deepEqual(pins, [7]);
  assert.deepEqual(
    first.events.map((e) => e.type),
    ['session', 'text_delta', 'text_delta', 'assistant_text', 'tool_use', 'tool_result', 'text_delta', 'text_delta', 'assistant_text', 'result'],
  );
  assert.equal(first.events[3].text, 'Let me turn it on.');
  assert.deepEqual(first.events[4], { type: 'tool_use', id: 'call_X', name: 'set_led', input: { pin: 7 } });
  assert.equal(first.events.at(-1).text, 'Done.');

  // Requests: system first, the key placeholder, tools in the chat format, the tool result as role:tool.
  const r1 = s.requests[0];
  assert.equal(r1.url, '/v1/chat/completions');
  assert.equal(r1.auth, 'Bearer not-needed');
  assert.equal(r1.body.stream, true);
  assert.deepEqual(r1.body.messages[0], { role: 'system', content: 'You are a test.' });
  assert.deepEqual(r1.body.messages[1], { role: 'user', content: 'light pin 7' });
  assert.equal(r1.body.tools[0].function.name, 'set_led');
  const m2 = s.requests[1].body.messages;
  assert.deepEqual(m2.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(m2[2].tool_calls, [{ id: 'call_X', type: 'function', function: { name: 'set_led', arguments: '{"pin": 7}' } }]);
  assert.deepEqual(m2[3], { role: 'tool', tool_call_id: 'call_X', content: 'LED on pin 7' });

  // Stored without the system prompt; the second prompt sees all of it.
  const saved = sessions.store.get(first.sessionId);
  assert.deepEqual(saved.items.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  s.replies.push({ frames: [chunk({ content: 'Pin 7.' }), chunk({}, 'stop'), DONE] });
  const second = await run({ provider: openaiChat, conn, apiKey: '', sessions, sessionId: first.sessionId, prompt: 'which pin?', tools: ledTools(pins) });
  assert.equal(second.code, 0);
  const m3 = s.requests[2].body.messages;
  assert.deepEqual(m3.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  assert.equal(m3[4].content, 'Done.');
});

test('chat: broken tool arguments give the model an error result, not a crashed run', async () => {
  const s = await fakeServer();
  s.replies.push({
    frames: [chunk({ tool_calls: [{ index: 0, id: 'call_B', type: 'function', function: { name: 'set_led', arguments: '{"pin": 7' } }] }), chunk({}, 'tool_calls'), DONE],
  });
  s.replies.push({ frames: [chunk({ content: 'Sorry.' }), chunk({}, 'stop'), DONE] });
  const pins = [];
  const sessions = memorySessions();
  const { code, events, sessionId } = await run({ provider: openaiChat, conn: { kind: 'ollama', baseUrl: s.baseURL, model: 'qwen2.5' }, apiKey: '', sessions, sessionId: null, prompt: 'x', tools: ledTools(pins) });
  assert.equal(code, 0);
  assert.deepEqual(pins, []);
  assert.equal(events.find((e) => e.type === 'tool_result').isError, true);
  assert.equal(s.requests[0].auth, 'Bearer ollama');
  // The history carries "{}" so a server that parses arguments does not reject the next turn.
  assert.equal(sessions.store.get(sessionId).items[1].tool_calls[0].function.arguments, '{}');
});

test('chat: images as data URLs; OpenRouter reasoning_details kept and sent back', async () => {
  const s = await fakeServer();
  s.replies.push({
    frames: [
      chunk({ reasoning: 'Think', reasoning_details: [{ type: 'reasoning.text', text: 'Thi', index: 0 }] }),
      chunk({ reasoning: 'ing', reasoning_details: [{ type: 'reasoning.text', text: 'nking', signature: 'SIG', index: 0 }] }),
      chunk({ tool_calls: [{ index: 0, id: 'call_R', type: 'function', function: { name: 'set_led', arguments: '{"pin":1}' } }] }, 'tool_calls'),
      DONE,
    ],
  });
  const items = openaiChat.userItems('see', [{ mediaType: 'image/jpeg', data: 'QQ==' }]);
  assert.deepEqual(items[0].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } });
  const r = await openaiChat.turn({ conn: { kind: 'openrouter', baseUrl: s.baseURL }, apiKey: 'k', model: 'g', system: 's', items, tools: [], onText: () => {} });
  assert.equal(r.stop, 'tools');
  assert.equal(r.append[0].content, null);
  assert.equal(r.append[0].reasoning, 'Thinking');
  assert.deepEqual(r.append[0].reasoning_details, [{ type: 'reasoning.text', text: 'Thinking', signature: 'SIG', index: 0 }]);
});

test('chat: finish reasons map to the contract stops', async () => {
  const s = await fakeServer();
  const conn = { kind: 'openai-compatible', baseUrl: s.baseURL };
  const cases = [
    ['length', 'max_tokens'],
    ['content_filter', 'refused'],
    ['stop', 'end'],
  ];
  for (const [finish, stop] of cases) {
    s.replies.push({ frames: [chunk({ content: 'x' }), chunk({}, finish), DONE] });
    const r = await openaiChat.turn({ conn, apiKey: '', model: 'm', system: '', items: openaiChat.userItems('hi'), tools: [] });
    assert.equal(r.stop, stop, finish);
  }
  // Tool calls under finish_reason "stop" (older Ollama) still run.
  s.replies.push({ frames: [chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'set_led', arguments: '{}' } }] }, 'stop'), DONE] });
  const r = await openaiChat.turn({ conn, apiKey: '', model: 'm', system: '', items: openaiChat.userItems('hi'), tools: [] });
  assert.equal(r.stop, 'tools');
});

test('chat: stopping the run mid-stream ends it as cancelled', async () => {
  const s = await fakeServer();
  s.replies.push({ frames: [chunk({ content: 'Thinking about it' })], hang: true });
  const { code, events } = await run({
    provider: openaiChat,
    conn: { kind: 'openai-compatible', baseUrl: s.baseURL, model: 'm' },
    apiKey: '',
    sessions: memorySessions(),
    sessionId: null,
    prompt: 'x',
    onStart: (handle, evs) => {
      const timer = setInterval(() => {
        if (evs.some((e) => e.type === 'text_delta')) {
          clearInterval(timer);
          handle.child.kill();
        }
      }, 5);
    },
  });
  assert.equal(code, 143);
  assert.equal(events.at(-1).subtype, 'cancelled');
  assert.ok(!events.some((e) => e.type === 'assistant_text'));
});

test('chat: errors become short sentences (401, Ollama without tools, missing model, unreachable)', async () => {
  const s = await fakeServer();
  const ollama = { kind: 'ollama', baseUrl: s.baseURL, model: 'gemma:2b' };
  const fail = async (conn, apiKey = '') => {
    try {
      await openaiChat.turn({ conn, apiKey, model: conn.model, system: '', items: openaiChat.userItems('hi'), tools: [{ name: 't', description: 'd', schema: { type: 'object' } }] });
    } catch (err) {
      return openaiChat.describeError(err);
    }
    throw new Error('expected a failure');
  };

  assert.equal(await fail({ kind: 'openai-compatible', baseUrl: s.baseURL, model: 'm' }, 'bad'), 'The API key was rejected.');

  // Ollama's OpenAI endpoint: 400 with "<model> does not support tools".
  s.replies.push({ status: 400, body: { error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools', type: 'api_error', param: null, code: null } } });
  assert.equal(await fail(ollama), 'This model does not support tools — pick another (e.g. qwen2.5, llama3.1).');

  s.replies.push({ status: 404, body: { error: { message: 'model "gemma:2b" not found, try pulling it first', type: 'api_error' } } });
  assert.equal(await fail(ollama), 'Model "gemma:2b" is not in Ollama — run "ollama pull gemma:2b" or pick another.');

  s.replies.push({ status: 404, body: { error: { message: 'The model does not exist' } } });
  assert.equal(await fail({ kind: 'openai-compatible', baseUrl: s.baseURL, model: 'nope' }), `Model "nope" not found at ${s.baseURL}.`);

  s.replies.push({ status: 429, body: { error: { message: 'slow down' } } });
  // The SDK retries a 429 (twice by default); script all three answers.
  s.replies.push({ status: 429, body: { error: { message: 'slow down' } } }, { status: 429, body: { error: { message: 'slow down' } } });
  assert.match(await fail({ kind: 'openai-compatible', baseUrl: s.baseURL, model: 'm' }), /^Too many requests/);

  assert.equal(await fail({ kind: 'openrouter', model: 'm' }), 'No API key is set for this connection.');

  // An APIConnectionError carries no server; the request's context names it.
  const err = new (await import('openai')).default.APIConnectionError({ message: 'Connection error.' });
  const tagged = await openai.withContext({ baseURL: 'http://127.0.0.1:1/v1', kind: 'openai-compatible' }, async () => { throw err; }).catch((e) => e);
  assert.equal(openaiChat.describeError(tagged), 'Cannot reach http://127.0.0.1:1/v1.');
});

test('chat: listModels — names as labels, OpenRouter keeps tool-capable text models', async () => {
  const s = await fakeServer();
  s.models = [
    { id: 'qwen2.5:latest', object: 'model', created: 1, owned_by: 'library' },
    { id: 'llama3.1:latest', object: 'model', created: 1, owned_by: 'library' },
  ];
  assert.deepEqual(await openaiChat.listModels({ conn: { kind: 'ollama', baseUrl: s.baseURL } }), [
    { id: 'llama3.1:latest', label: 'llama3.1:latest' },
    { id: 'qwen2.5:latest', label: 'qwen2.5:latest' },
  ]);

  s.models = [
    { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', supported_parameters: ['tools', 'reasoning'], architecture: { output_modalities: ['text'] } },
    { id: 'old/no-tools', name: 'Old: No Tools', supported_parameters: ['temperature'], architecture: { output_modalities: ['text'] } },
    { id: 'img/gen', name: 'Img: Gen', supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
    { id: 'anthropic/claude', name: 'Anthropic: Claude', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
  ];
  assert.deepEqual(await openaiChat.listModels({ conn: { kind: 'openrouter', baseUrl: s.baseURL }, apiKey: 'k' }), [
    { id: 'anthropic/claude', label: 'Anthropic: Claude' },
    { id: 'openai/gpt-5', label: 'OpenAI: GPT-5' },
  ]);  // OpenRouter lists models to anyone: the key is checked on its own.
  assert.ok(s.requests.some((r) => r.url.endsWith('/key') && r.auth === 'Bearer k'));
  await assert.rejects(openaiChat.listModels({ conn: { kind: 'openrouter', baseUrl: s.baseURL }, apiKey: 'bad' }));
});
