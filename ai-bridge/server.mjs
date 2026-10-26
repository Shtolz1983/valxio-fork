// Velxio AI bridge.
//
//   browser (IDE tab) ──ws /ws──▶ bridge ──spawn──▶ claude -p
//                     ◀─tool calls─┘   ▲              │
//                                      └─http /mcp/<tab>┘ (MCP tools)
//
// Messages may carry photos ({ mediaType, data }): they go to claude as image
// blocks of a stream-json user message. A photo of a module can also be
// identified first (identify_part, no tools): the user confirms a candidate,
// then the card author writes its card with the photo at hand.
//
// A second kind of run writes parts-catalog cards ("+ Add sensor"): claude
// gets WebSearch/WebFetch and a single MCP tool, submit_part_card
// (/mcp-cards/<job>), which checks the card (partCards.mjs) and stores it as
// a draft through the Velxio backend.
//
// `claude -p` runs on the host with the user's own Claude Code login, so no
// API key is needed. Its only tools are the MCP tools below; each browser tool
// call is forwarded to the connected IDE tab, which runs it against the canvas.
//
// Which login and model answer is the user's choice in the IDE ("AI
// connections", connections.mjs): one connection for the chat, one for the
// card author and the photo identification.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS, DEFAULT_TIMEOUT_MS } from './tools.mjs';
import { buildClaudeArgs, runClaude, sanitizeImages, withReplyLanguage } from './claudeRunner.mjs';
import { buildIdentifyPrompt, parseIdentification } from './identify.mjs';
import { catalogSection, verifyCard } from './partCards.mjs';
import { ConnectionStore, KINDS, connectionBaseUrl, connectionEnv } from './connections.mjs';
import { accountStatus, startLogin } from './claudeAccounts.mjs';
import { KeyStore } from './keyStore.mjs';
import { ApiSessions } from './apiSessions.mjs';
import { runApiAgent, toolSet } from './apiAgent.mjs';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.AI_BRIDGE_PORT ?? 8787);
const VELXIO_URL = process.env.VELXIO_URL ?? 'http://localhost:3080';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const ALLOWED_ORIGINS = new Set(
  (process.env.AI_BRIDGE_ORIGINS ?? 'http://localhost:3080,http://127.0.0.1:3080,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const SYSTEM_PROMPT = readFileSync(path.join(HERE, 'system-prompt.md'), 'utf8');
const CARD_PROMPT = readFileSync(path.join(HERE, 'card-author-prompt.md'), 'utf8');
const IDENTIFY_PROMPT = readFileSync(path.join(HERE, 'identify-prompt.md'), 'utf8');
/** Cards shown to the card author as the pattern to follow. */
const EXAMPLE_CARD_IDS = ['ds18b20', 'bme280', 'soil-moisture'];
// Empty working directory outside the repo, so claude picks up no project
// files, settings or per-project memory.
const WORKDIR = path.join(os.tmpdir(), 'velxio-ai-bridge');
mkdirSync(WORKDIR, { recursive: true });
const connections = new ConnectionStore({ systemModel: CLAUDE_MODEL });
const keys = new KeyStore({ home: connections.home });
const apiSessions = new ApiSessions(connections.home);

// ── Browser link ────────────────────────────────────────────────────────────

// Connected IDE tabs by id. Each tab's claude run gets its own MCP URL
// (/mcp/<tabId>), so tool calls land in the tab that asked — never in
// another open tab with a different circuit.
const tabs = new Map(); // tabId → ws
const pending = new Map(); // callId → { resolve, reject, timer }

function send(ws, msg) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function callBrowser(tabId, name, args, timeoutMs) {
  const browser = tabs.get(tabId);
  if (!browser || browser.readyState !== browser.OPEN) {
    return Promise.reject(new Error('The Velxio IDE tab is not connected to the AI bridge.'));
  }
  const callId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`Tool ${name} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    pending.set(callId, { resolve, reject, timer });
    send(browser, { type: 'tool_call', callId, name, args });
  });
}

function settleCall({ callId, ok, result, error }) {
  const p = pending.get(callId);
  if (!p) return;
  pending.delete(callId);
  clearTimeout(p.timer);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'Tool failed'));
}

// ── Bridge-side tools ───────────────────────────────────────────────────────

const BRIDGE_TOOLS = {
  async install_library({ name, version }) {
    const res = await fetch(`${VELXIO_URL}/api/libraries/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, version }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || body.detail || `HTTP ${res.status}`);
    return { installed: name, log: String(body.stdout ?? '').slice(-1500) };
  },
};

// ── API connections (apiAgent.mjs) ──────────────────────────────────────────

/** The adapter of an API kind, loaded when first used. */
function providerFor(kind) {
  if (kind === 'anthropic') return import('./providers/anthropic.mjs');
  if (kind === 'openai') return import('./providers/openai.mjs');
  return import('./providers/openaiChat.mjs');
}

/** The canvas tools as an API run gets them: the same ones `claude -p` gets over MCP. */
function canvasTools(tabId) {
  return toolSet(
    TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input: t.input,
      execute: (args) =>
        t.where === 'bridge' ? BRIDGE_TOOLS[t.name](args) : callBrowser(tabId, t.name, args, t.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })),
  );
}

/** A handle like runClaude's for a run that cannot start (no key, no adapter). */
function failedRun(onEvent, message) {
  onEvent({ type: 'error', message });
  onEvent({ type: 'result', isError: true, subtype: 'error', text: '', numTurns: 0 });
  return { child: { kill() {} }, done: Promise.resolve({ code: 1 }) };
}

async function startApi(conn, { system, sessionId = null, prompt, images = [], tools = [], webSearch = false, onEvent }) {
  const meta = KINDS[conn.kind];
  const apiKey = meta.key === 'none' ? null : await keys.get(conn.id);
  if (meta.key === 'required' && !apiKey) return failedRun(onEvent, `"${conn.label}" has no API key: add it in AI connections.`);
  let provider;
  try {
    provider = await providerFor(conn.kind);
  } catch (err) {
    return failedRun(onEvent, `No adapter for ${meta.label} here: ${err.message}`);
  }
  return runApiAgent({
    provider,
    conn: { ...conn, baseUrl: connectionBaseUrl(conn) },
    apiKey,
    system,
    sessions: apiSessions,
    sessionId,
    prompt,
    images,
    tools,
    webSearch,
    onEvent,
  });
}

const PRIVATE_HOST = /^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
const PAGE_CHARS = 40_000;

/** A public web page as text, for an API card author's research (no browser, no cookies). */
async function fetchPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('not a URL');
  }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new Error('only public http(s) pages can be fetched');
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: 'follow', headers: { 'User-Agent': 'velxio-ai-bridge' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text|json|xml/.test(type)) throw new Error(`not a text page (${type || 'unknown type'}); look for an HTML or source page instead`);
  let text = (await res.text()).slice(0, 2_000_000);
  if (/html/.test(type)) {
    text = text
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n');
  }
  return text.length > PAGE_CHARS ? `${text.slice(0, PAGE_CHARS)}\n… [page cut at ${PAGE_CHARS} characters]` : text;
}

// ── MCP endpoint (stateless: a fresh server per request) ────────────────────

function buildMcpServer(tabId) {
  const server = new McpServer({ name: 'velxio', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      try {
        const result =
          tool.where === 'bridge'
            ? await BRIDGE_TOOLS[tool.name](args ?? {})
            : await callBrowser(tabId, tool.name, args ?? {}, tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }
  return server;
}

// ── Card author jobs ("+ Add sensor") ─────────────────────────────────────

const cardJobs = new Map(); // jobId → { ws, savedId }

const SUBMIT_CARD_DESCRIPTION =
  'Check and save a parts-catalogue card: schema, library installs, example compile for Uno and ESP32, and for a register-map card ("sim.model": "regmap") a simulation run on Nano and ESP32 that checks the printed numbers follow the panel. Returns { ok, problems } — fix the problems and submit again.';
const SUBMIT_CARD_INPUT = { card: z.record(z.string(), z.unknown()).describe('The card JSON object') };

async function fetchCatalog() {
  const res = await fetch(`${VELXIO_URL}/api/parts-catalog/`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`parts catalogue: HTTP ${res.status}`);
  return (await res.json()).cards ?? [];
}

async function submitPartCard(jobId, card) {
  const job = cardJobs.get(jobId);
  if (!job) throw new Error('This card job has ended.');
  const status = (text) => send(job.ws, { type: 'card_status', text });
  const existing = (await fetchCatalog()).find((c) => c.id === card?.id);
  if (existing?.status === 'verified') {
    return { ok: false, problems: [`id "${card.id}" is already a confirmed card — pick another id`] };
  }
  const draft = { ...card, status: 'draft' };
  status(
    draft.sim?.model === 'regmap'
      ? 'checking the card: libraries, compile and simulation on Nano and ESP32…'
      : 'checking the card: libraries and compile for Uno and ESP32…',
  );
  const result = await verifyCard(draft, { velxioUrl: VELXIO_URL, log: status });
  if (!result.ok) {
    status(`the check found ${result.problems.length} problem(s), the assistant is fixing them`);
    return { ok: false, problems: result.problems, passed: result.steps };
  }
  const res = await fetch(`${VELXIO_URL}/api/parts-catalog/${encodeURIComponent(draft.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, problems: [`could not save: ${body.detail ?? `HTTP ${res.status}`}`] };
  }
  job.savedId = draft.id;
  send(job.ws, { type: 'card_saved', id: draft.id, checks: result.steps });
  return { ok: true, saved: draft.id, checks: result.steps };
}

function buildCardMcpServer(jobId) {
  const server = new McpServer({ name: 'velxio', version: '0.1.0' });
  server.registerTool(
    'submit_part_card',
    {
      description: SUBMIT_CARD_DESCRIPTION,
      inputSchema: SUBMIT_CARD_INPUT,
    },
    async ({ card }) => {
      try {
        const result = await submitPartCard(jobId, card);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.ok };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    },
  );
  return server;
}

async function startCardJob(ws, state, query, images = []) {
  if (state.run) {
    send(ws, { type: 'error', message: 'The assistant is still working on the previous request.' });
    return;
  }
  const jobId = randomUUID();
  cardJobs.set(jobId, { ws, savedId: null });
  send(ws, { type: 'busy', busy: true });
  let systemPrompt;
  try {
    const cards = await fetchCatalog();
    const examples = cards.filter((c) => EXAMPLE_CARD_IDS.includes(c.id));
    systemPrompt =
      `${CARD_PROMPT}\n` +
      examples.map((c) => '```json\n' + JSON.stringify(c, null, 2) + '\n```').join('\n\n') +
      `\n\n## Ids already in the catalogue\n\n${cards.map((c) => c.id).join(', ')}\n`;
  } catch (err) {
    cardJobs.delete(jobId);
    send(ws, { type: 'error', message: `The Velxio backend (${VELXIO_URL}) did not answer: ${err.message}` });
    send(ws, { type: 'busy', busy: false });
    return;
  }
  const conn = connections.selected('cards');
  send(ws, { type: 'card_status', text: `researching "${query}"…` });
  const prompt = images.length
    ? `Write the parts-catalogue card for: ${query}\n\nThe user photographed the module (attached) and confirmed it is this part. ` +
      'Read the pin labels and their order from the silkscreen in the photo; when the photo and a datasheet disagree on the pinout, the photo shows the board the user has.'
    : `Write the parts-catalogue card for: ${query}`;
  if (conn.kind === 'claude-code') {
    state.run = runClaude({
      bin: CLAUDE_BIN,
      args: buildClaudeArgs({
        mcpUrl: `http://${HOST}:${PORT}/mcp-cards/${jobId}`,
        systemPrompt,
        model: conn.model,
        tools: 'WebSearch,WebFetch',
        allowedTools: 'mcp__velxio WebSearch WebFetch',
        streamInput: images.length > 0,
      }),
      prompt,
      images,
      cwd: WORKDIR,
      // submit_part_card compiles for ESP32 too: give the tool call minutes.
      env: { MCP_TOOL_TIMEOUT: String(20 * 60_000), ...connectionEnv(conn) },
      onEvent: (ev) => send(ws, ev),
    });
  } else {
    // Anthropic and OpenAI search the web themselves; the other API kinds
    // have only fetch_page and what the model knows.
    const webSearch = conn.kind === 'anthropic' || conn.kind === 'openai';
    state.run = { child: { kill() {} } };
    state.run = await startApi(conn, {
      system:
        `${systemPrompt}\n## Tools in this run\n\n` +
        (webSearch
          ? 'Research with `web_search` and `fetch_page` (read a page found by search: a datasheet, the library source on GitHub).\n'
          : 'There is no web search in this run: `fetch_page` reads pages whose address you know (the library repository on GitHub, ' +
            'the manufacturer datasheet). Where you cannot read a source, write from what you know; the card check compiles and simulates the example and reports what is wrong.\n'),
      prompt,
      images,
      webSearch,
      tools: toolSet([
        { name: 'submit_part_card', description: SUBMIT_CARD_DESCRIPTION, input: SUBMIT_CARD_INPUT, execute: ({ card }) => submitPartCard(jobId, card) },
        {
          name: 'fetch_page',
          description: 'Read a public web page or file (datasheet page, library README or source on GitHub) as plain text.',
          input: { url: z.string().describe('http(s) address') },
          execute: ({ url }) => fetchPage(url),
        },
      ]),
      onEvent: (ev) => send(ws, ev),
    });
  }
  state.run.done.then(() => {
    const job = cardJobs.get(jobId);
    cardJobs.delete(jobId);
    state.run = null;
    if (!job?.savedId) send(ws, { type: 'card_failed' });
    send(ws, { type: 'busy', busy: false });
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function handleMcp(req, res, server) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const body = await readJson(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ── Photo identification ("what module is this?") ───────────────────────────

async function startIdentify(ws, state, images, hint, language) {
  if (state.run) {
    send(ws, { type: 'error', message: 'The assistant is still working on the previous request.' });
    return;
  }
  send(ws, { type: 'busy', busy: true });
  let cards;
  try {
    cards = await fetchCatalog();
  } catch (err) {
    send(ws, { type: 'identify_failed', message: `The Velxio backend (${VELXIO_URL}) did not answer: ${err.message}` });
    send(ws, { type: 'busy', busy: false });
    return;
  }
  const conn = connections.selected('cards');
  const systemPrompt = buildIdentifyPrompt(IDENTIFY_PROMPT, cards, language);
  const prompt = hint ? `What module is this? The user adds: ${hint}` : 'What module is this?';
  let answer = '';
  const onEvent = (ev) => {
    if (ev.type === 'result') answer = ev.isError ? '' : ev.text;
    if (ev.type === 'error') send(ws, ev);
  };
  if (conn.kind === 'claude-code') {
    state.run = runClaude({
      bin: CLAUDE_BIN,
      args: buildClaudeArgs({ systemPrompt, model: conn.model, allowedTools: '', streamInput: true }),
      prompt,
      images,
      cwd: WORKDIR,
      env: connectionEnv(conn),
      onEvent,
    });
  } else {
    state.run = { child: { kill() {} } };
    state.run = await startApi(conn, { system: systemPrompt, prompt, images, onEvent });
  }
  state.run.done.then(() => {
    state.run = null;
    try {
      send(ws, { type: 'part_identified', ...parseIdentification(answer, cards.map((c) => c.id)) });
    } catch (err) {
      send(ws, { type: 'identify_failed', message: err.message });
    }
    send(ws, { type: 'busy', busy: false });
  });
}

// ── Chat sessions (one per IDE tab) ─────────────────────────────────────────

/** The catalogue section of the chat prompt; without a backend the chat still works, just without it. */
async function catalogPromptSection() {
  try {
    return catalogSection(await fetchCatalog());
  } catch (err) {
    console.warn('[ai-bridge] parts catalogue not read for the chat prompt:', err.message);
    return '';
  }
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function startPrompt(ws, state, text, language, images = [], retried = false) {
  if (state.run) {
    send(ws, { type: 'error', message: 'The assistant is still working on the previous request.' });
    return;
  }
  // Marks the tab busy while the catalogue is read, so a second prompt in
  // that moment is refused like any other overlapping one.
  state.run = { child: { kill() {} } };
  send(ws, { type: 'busy', busy: true });
  const catalog = await catalogPromptSection();
  state.run = null;
  // A session belongs to the login it was made under: another connection
  // starts a new one (the transcript stays on screen).
  const conn = connections.selected('chat');
  if (state.sessionId && state.sessionConn && state.sessionConn !== conn.id) {
    state.sessionId = null;
    send(ws, { type: 'session', sessionId: null });
    send(ws, { type: 'session_switched', label: conn.label });
  }
  const systemPrompt = withReplyLanguage(SYSTEM_PROMPT + catalog, language);
  // The tab's saved session may be gone from Claude's store (cleared, another
  // machine): then nothing ran, and the prompt goes again in a new session.
  let lost = false;
  const onEvent = (ev) => {
    if (ev.type === 'result' && ev.sessionLost && !retried) {
      lost = true;
      return;
    }
    if (ev.type === 'session') {
      state.sessionId = ev.sessionId;
      state.sessionConn = conn.id;
      send(ws, { ...ev, connectionId: conn.id });
      return;
    }
    send(ws, ev);
  };
  if (conn.kind === 'claude-code') {
    state.run = runClaude({
      bin: CLAUDE_BIN,
      args: buildClaudeArgs({
        mcpUrl: `http://${HOST}:${PORT}/mcp/${state.tabId}`,
        systemPrompt,
        model: conn.model,
        sessionId: state.sessionId,
        streamInput: images.length > 0,
      }),
      prompt: text || 'Look at the attached photo.',
      images,
      cwd: WORKDIR,
      env: connectionEnv(conn),
      onEvent,
    });
  } else {
    state.run = { child: { kill() {} } };
    state.run = await startApi(conn, {
      system: systemPrompt,
      sessionId: state.sessionId,
      prompt: text,
      images,
      tools: canvasTools(state.tabId),
      onEvent,
    });
  }
  state.run.done.then(() => {
    state.run = null;
    if (lost) {
      state.sessionId = null;
      send(ws, { type: 'session', sessionId: null });
      send(ws, { type: 'session_lost' });
      void startPrompt(ws, state, text, language, images, true);
      return;
    }
    send(ws, { type: 'busy', busy: false });
  });
}

// ── AI connections (connections.mjs) ────────────────────────────────────────

/** Account status per config folder, kept a minute: `claude auth status` takes a moment. */
const accountCache = new Map(); // configDir|'' → { at, status }
const logins = new Map(); // connection id → { submitCode, cancel }

async function cachedAccount(conn, fresh = false) {
  const key = conn.configDir ?? '';
  const hit = accountCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.status;
  const status = await accountStatus(CLAUDE_BIN, conn.configDir);
  accountCache.set(key, { at: Date.now(), status });
  return status;
}

/** Whether an API connection has its key, kept so a snapshot does not ask the keychain each time. */
const keyPresent = new Map(); // connection id → boolean

async function hasKey(id) {
  if (!keyPresent.has(id)) keyPresent.set(id, !!(await keys.get(id)));
  return keyPresent.get(id);
}

/** What the IDE shows for a connection's login: the account, or whether the key is there. */
async function connectionAccount(conn) {
  const meta = KINDS[conn.kind];
  if (!meta.api) return cachedAccount(conn);
  if (meta.key === 'none') return { loggedIn: true };
  const set = await hasKey(conn.id);
  return set || meta.key === 'optional' ? { loggedIn: true, keySet: set } : { loggedIn: false, keySet: false, error: 'no API key' };
}

async function connectionsSnapshot() {
  const list = connections.list();
  const accounts = await Promise.all(list.map((c) => connectionAccount(c)));
  return {
    type: 'connections',
    kinds: Object.fromEntries(
      Object.entries(KINDS).map(([k, v]) => [
        k,
        { label: v.label, models: v.models, api: !!v.api, key: v.key ?? 'none', baseUrl: v.baseUrl ?? null, needsBaseUrl: !!v.needsBaseUrl },
      ]),
    ),
    connections: list.map((c, i) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      model: c.model,
      // A folder the user brought (shown); one the bridge made is its own business.
      configDir: c.managed ? null : c.configDir,
      baseUrl: c.baseUrl ?? null,
      system: c.id === 'system',
      account: accounts[i],
      signingIn: logins.has(c.id),
    })),
    selected: connections.selection(),
  };
}

async function sendConnections(ws) {
  send(ws, await connectionsSnapshot());
}

async function broadcastConnections() {
  const snap = await connectionsSnapshot();
  for (const ws of tabs.values()) send(ws, snap);
}

/** Sign a Claude Code account's folder in; progress goes to the tab that asked. */
function beginLogin(ws, id) {
  const conn = connections.get(id);
  if (!conn || conn.kind !== 'claude-code') throw new Error('no such account');
  logins.get(id)?.cancel();
  const login = startLogin(CLAUDE_BIN, conn.configDir, (update) => {
    send(ws, { type: 'connection_login', id, ...update });
    if (update.done) {
      logins.delete(id);
      accountCache.delete(conn.configDir ?? '');
      void broadcastConnections();
    }
  });
  logins.set(id, login);
}

async function onConnectionMessage(ws, msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  try {
    switch (msg.type) {
      case 'connections_list':
        await sendConnections(ws);
        return;
      case 'connection_models': {
        // The models a provider offers, for the add form (a key typed there,
        // not saved yet) or an existing connection (its saved key).
        const existing = id ? connections.get(id) : null;
        const kind = existing?.kind ?? msg.kind;
        if (!KINDS[kind]?.api) throw new Error('not an API connection');
        const apiKey = typeof msg.apiKey === 'string' && msg.apiKey ? msg.apiKey : existing ? await keys.get(existing.id) : null;
        const conn = existing ?? { kind, baseUrl: msg.baseUrl || null };
        const requestId = msg.requestId ?? null;
        try {
          const provider = await providerFor(kind);
          try {
            const models = await provider.listModels({ conn: { ...conn, baseUrl: connectionBaseUrl(conn) }, apiKey, signal: AbortSignal.timeout(20_000) });
            send(ws, { type: 'connection_models', requestId, models });
          } catch (err) {
            send(ws, { type: 'connection_models', requestId, error: provider.describeError(err) });
          }
        } catch (err) {
          send(ws, { type: 'connection_models', requestId, error: `no adapter for this kind: ${err.message}` });
        }
        return;
      }
      case 'connection_add': {
        const meta = KINDS[msg.kind];
        if (meta?.key === 'required' && !(typeof msg.apiKey === 'string' && msg.apiKey)) throw new Error('the API key is missing');
        if (msg.apiKey && !KeyStore.validKey(msg.apiKey)) throw new Error('that does not look like an API key');
        const conn = connections.add({ kind: msg.kind, label: msg.label, model: msg.model, configDir: msg.configDir, baseUrl: msg.baseUrl });
        if (msg.apiKey) {
          try {
            await keys.set(conn.id, msg.apiKey);
            keyPresent.set(conn.id, true);
          } catch (err) {
            connections.remove(conn.id);
            throw err;
          }
        }
        send(ws, { type: 'connection_added', id: conn.id });
        // A new folder of our own: sign it in right away.
        if (msg.signIn && conn.managed) beginLogin(ws, conn.id);
        break;
      }
      case 'connection_update':
        connections.update(id, { label: msg.label, model: msg.model });
        break;
      case 'connection_remove': {
        logins.get(id)?.cancel();
        const conn = connections.get(id);
        connections.remove(id);
        if (conn && KINDS[conn.kind].api) {
          await keys.delete(id);
          keyPresent.delete(id);
        }
        break;
      }
      case 'connection_set_key': {
        const conn = connections.get(id);
        if (!conn || !KINDS[conn.kind].api) throw new Error('not an API connection');
        await keys.set(id, msg.apiKey);
        keyPresent.set(id, true);
        break;
      }
      case 'connection_select':
        connections.select(msg.role, id);
        break;
      case 'connection_login':
        beginLogin(ws, id);
        break;
      case 'connection_login_code':
        logins.get(id)?.submitCode(msg.code);
        return;
      case 'connection_login_cancel':
        logins.get(id)?.cancel();
        return;
      default:
        return;
    }
    await broadcastConnections();
  } catch (err) {
    send(ws, { type: 'connection_error', message: err.message });
  }
}

function onSocket(ws) {
  const state = { tabId: randomUUID(), sessionId: null, sessionConn: null, run: null };
  tabs.set(state.tabId, ws);
  const chatConn = connections.selected('chat');
  send(ws, { type: 'hello', model: chatConn.model, connection: chatConn.label });
  void sendConnections(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    let images;
    try {
      images = sanitizeImages(msg.images);
    } catch (err) {
      send(ws, { type: 'error', message: `Photo not accepted: ${err.message}` });
      return;
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    switch (msg.type) {
      case 'prompt':
        if (text || images.length) void startPrompt(ws, state, text, msg.language, images);
        break;
      case 'identify_part':
        if (images.length) void startIdentify(ws, state, images, text.slice(0, 300), msg.language);
        break;
      case 'make_part_card':
        if (typeof msg.query === 'string' && msg.query.trim()) {
          void startCardJob(ws, state, msg.query.trim().slice(0, 200), images);
        }
        break;
      case 'cancel':
        state.run?.child.kill('SIGTERM');
        break;
      case 'reset':
        state.run?.child.kill('SIGTERM');
        state.sessionId = null;
        break;
      case 'resume':
        // The tab's saved chat (a reload, another project opened): continue
        // its Claude session, under the connection it was made with.
        state.run?.child.kill('SIGTERM');
        state.sessionId = typeof msg.sessionId === 'string' && SESSION_ID.test(msg.sessionId) ? msg.sessionId : null;
        state.sessionConn = typeof msg.connectionId === 'string' ? msg.connectionId : null;
        break;
      default:
        if (typeof msg.type === 'string' && msg.type.startsWith('connection')) void onConnectionMessage(ws, msg);
      case 'tool_result':
        settleCall(msg);
        break;
    }
  });

  ws.on('close', () => {
    state.run?.child.kill('SIGTERM');
    tabs.delete(state.tabId);
  });
}

// ── HTTP server ─────────────────────────────────────────────────────────────

// Only local clients: rejects DNS-rebinding requests that carry a foreign Host.
function isLocalHost(hostHeader) {
  return hostHeader === `${HOST}:${PORT}` || hostHeader === `localhost:${PORT}`;
}

const httpServer = http.createServer(async (req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const mcp = /^\/mcp\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (mcp) return await handleMcp(req, res, buildMcpServer(mcp[1]));
    const cardMcp = /^\/mcp-cards\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (cardMcp && cardJobs.has(cardMcp[1])) return await handleMcp(req, res, buildCardMcpServer(cardMcp[1]));
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, tabsConnected: tabs.size, model: CLAUDE_MODEL }));
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error('[ai-bridge]', err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/ws' || !isLocalHost(req.headers.host) || !ALLOWED_ORIGINS.has(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
});

httpServer.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Another bridge already answers on this port (the login agent, or one
  // started in another terminal). A clean exit keeps the login agent from
  // restarting this one over and over.
  console.error(`[ai-bridge] port ${PORT} is already in use: another bridge is running (see: npm run autostart -- status)`);
  process.exit(0);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[ai-bridge] listening on http://${HOST}:${PORT} (model: ${CLAUDE_MODEL}, Velxio: ${VELXIO_URL})`);
});
