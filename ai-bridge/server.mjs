// Velxio AI bridge.
//
//   browser (IDE tab) ──ws /ws──▶ bridge ──spawn──▶ claude -p
//                     ◀─tool calls─┘   ▲              │
//                                      └──http /mcp───┘ (MCP tools)
//
// `claude -p` runs on the host with the user's own Claude Code login, so no
// API key is needed. Its only tools are the MCP tools below; each browser tool
// call is forwarded to the connected IDE tab, which runs it against the canvas.
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
import { buildClaudeArgs, runClaude } from './claudeRunner.mjs';

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
// Empty working directory outside the repo, so claude picks up no project
// files, settings or per-project memory.
const WORKDIR = path.join(os.tmpdir(), 'velxio-ai-bridge');
mkdirSync(WORKDIR, { recursive: true });

// ── Browser link ────────────────────────────────────────────────────────────

let browser = null; // the most recently connected IDE tab
const pending = new Map(); // callId → { resolve, reject, timer }

function send(ws, msg) {
  if (ws?.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function callBrowser(name, args, timeoutMs) {
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

// ── MCP endpoint (stateless: a fresh server per request) ────────────────────

function buildMcpServer() {
  const server = new McpServer({ name: 'velxio', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      try {
        const result =
          tool.where === 'bridge'
            ? await BRIDGE_TOOLS[tool.name](args ?? {})
            : await callBrowser(tool.name, args ?? {}, tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    });
  }
  return server;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  const body = await readJson(req);
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ── Chat sessions (one per IDE tab) ─────────────────────────────────────────

function startPrompt(ws, state, text) {
  if (state.run) {
    send(ws, { type: 'error', message: 'The assistant is still working on the previous request.' });
    return;
  }
  const args = buildClaudeArgs({
    mcpUrl: `http://${HOST}:${PORT}/mcp`,
    systemPrompt: SYSTEM_PROMPT,
    model: CLAUDE_MODEL,
    sessionId: state.sessionId,
  });
  send(ws, { type: 'busy', busy: true });
  state.run = runClaude({
    bin: CLAUDE_BIN,
    args,
    prompt: text,
    cwd: WORKDIR,
    onEvent: (ev) => {
      if (ev.type === 'session') state.sessionId = ev.sessionId;
      send(ws, ev);
    },
  });
  state.run.done.then(() => {
    state.run = null;
    send(ws, { type: 'busy', busy: false });
  });
}

function onSocket(ws) {
  const state = { sessionId: null, run: null };
  browser = ws;
  send(ws, { type: 'hello', model: CLAUDE_MODEL });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'prompt':
        if (typeof msg.text === 'string' && msg.text.trim()) startPrompt(ws, state, msg.text);
        break;
      case 'cancel':
        state.run?.child.kill('SIGTERM');
        break;
      case 'reset':
        state.run?.child.kill('SIGTERM');
        state.sessionId = null;
        break;
      case 'tool_result':
        settleCall(msg);
        break;
    }
  });

  ws.on('close', () => {
    state.run?.child.kill('SIGTERM');
    if (browser === ws) browser = null;
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
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, browserConnected: !!browser, model: CLAUDE_MODEL }));
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

httpServer.listen(PORT, HOST, () => {
  console.log(`[ai-bridge] listening on http://${HOST}:${PORT} (model: ${CLAUDE_MODEL}, Velxio: ${VELXIO_URL})`);
});
