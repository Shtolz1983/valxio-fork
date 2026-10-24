# Velxio AI bridge

Lets the editor's **AI assistant** panel drive the canvas with Claude, using your own
Claude Code login (`claude -p`) — no API key.

```
IDE tab ──ws://127.0.0.1:8787/ws──▶ ai-bridge ──spawn──▶ claude -p
   ▲  tool calls (add_component, connect, compile, …)        │
   └──────────── forwarded ◀── http://127.0.0.1:8787/mcp ◀───┘
```

- `server.mjs` — WebSocket for the IDE tab, stateless MCP endpoint for `claude`, spawns one
  `claude -p` per prompt and resumes the session for follow-ups.
- `claudeRunner.mjs` — builds the `claude` command line and maps its `stream-json` output to
  chat events.
- `tools.mjs` — the MCP tool catalogue. Browser tools are implemented in
  `frontend/src/ai/tools.ts` under the same names; keep the two in sync.
- `system-prompt.md` — the assistant's instructions (workflow + electrical rules).

`claude` runs with no built-in tools (`--tools ""`), no settings (`--setting-sources ""`) and only
the `velxio` MCP server, in an empty directory under the OS temp dir — it can change the canvas
and nothing else on your machine.

## Run

Requires Node 20+ and Claude Code logged in (`claude` works in your terminal).

```bash
cd ai-bridge
npm install
npm start
```

Then open the editor (http://localhost:3080 from Docker, or http://localhost:5173 from
`npm run dev`) and click the **AI** tab on the right edge. The dot in the panel header turns green
when the bridge is connected.

| Env var | Default | Meaning |
|---|---|---|
| `AI_BRIDGE_PORT` | `8787` | Port (bound to 127.0.0.1 only) |
| `CLAUDE_MODEL` | `sonnet` | Model alias or id passed to `claude --model` |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `VELXIO_URL` | `http://localhost:3080` | Backend used by `install_library` |
| `AI_BRIDGE_ORIGINS` | localhost:3080 / 5173 | Origins allowed to open the WebSocket |

The frontend connects to `ws://127.0.0.1:8787/ws`; override with `VITE_AI_BRIDGE_URL` at build time.

## Test

```bash
npm test
```
