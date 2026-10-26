# Velxio AI bridge

Lets the editor's **AI assistant** panel drive the canvas with Claude, using your own
Claude Code login (`claude -p`) — no API key.

```
IDE tab ──ws://127.0.0.1:8787/ws──▶ ai-bridge ──spawn──▶ claude -p
   ▲  tool calls (add_component, connect, compile, …)        │
   └──────── forwarded ◀── http://127.0.0.1:8787/mcp/<tab> ◀───┘
```

- `server.mjs` — WebSocket for IDE tabs, a stateless MCP endpoint per tab (`/mcp/<tabId>`, so tool
  calls reach the tab that asked), spawns one `claude -p` per prompt and resumes the session for
  follow-ups. The tab picks the reply language; it is added to the system prompt each turn.
- `claudeRunner.mjs` — builds the `claude` command line and maps its `stream-json` output to
  chat events.
- `tools.mjs` — the MCP tool catalogue. Browser tools are implemented in
  `frontend/src/ai/tools.ts` under the same names; keep the two in sync.
- `system-prompt.md` — the assistant's instructions (workflow + electrical rules).
- `partCards.mjs`, `card-author-prompt.md` — "+ Add sensor" in the editor's Sensors catalogue: a
  separate `claude -p` run with WebSearch/WebFetch and one MCP tool, `submit_part_card`
  (`/mcp-cards/<job>`), which checks the card (schema, library installs, example compiles for Uno and
  ESP32 through the Velxio backend) and saves it as a draft in `parts-catalog/`.
  `npm run verify-cards` runs the same check over every card.
- Photos: a `prompt` or `make_part_card` message may carry `images: [{ mediaType, data }]` (JPEG,
  PNG, WebP or GIF as base64, at most 4, 5 MB each); they reach claude as image blocks of a
  `--input-format stream-json` user message. `identify_part` (`identify.mjs`,
  `identify-prompt.md`) is a run with no tools at all that answers `part_identified` with up to 3
  candidate modules for a photo; the user confirms one before the card author writes anything, and
  the author gets the photo to read the pinout off the board.

`claude` runs with no built-in tools (`--tools ""`), no settings (`--setting-sources ""`) and only
the `velxio` MCP server, in an empty directory under the OS temp dir — it can change the canvas
and nothing else on your machine. The card author additionally gets WebSearch and WebFetch (reading
the web, not your files).

## Run

Requires Node 22.18+ (it runs the TypeScript sources it shares with the frontend;
`.nvmrc` names 24) and Claude Code logged in (`claude` works in your terminal).
`start.mjs` checks the version before loading `server.mjs`.

```bash
cd ai-bridge
npm install
npm run autostart        # macOS: start now and at every login
npm start                # or: run until the terminal closes
```

`npm run autostart` (`scripts/autostart.mjs`) installs a LaunchAgent,
`~/Library/LaunchAgents/dev.velxio.ai-bridge.plist`, that runs `start.mjs` with
the Node it was run with, restarts the bridge after a crash, and logs to
`~/Library/Logs/velxio-ai-bridge.log`. It keeps the env vars below and the
shell's `PATH` as they were when it ran. `npm run autostart -- status` reports
it, `npm run autostart:remove` uninstalls it. A second bridge on a taken port
exits cleanly, so the agent does not restart it.

Then open the editor (http://localhost:3080 from Docker, or http://localhost:5173 from
`npm run dev`) and click the **AI** tab on the right edge. The dot in the panel header turns green
when the bridge is connected.

| Env var | Default | Meaning |
|---|---|---|
| `AI_BRIDGE_PORT` | `8787` | Port (bound to 127.0.0.1 only) |
| `CLAUDE_MODEL` | `sonnet` | Model of the built-in connection on first run (later chosen in the IDE) |
| `VELXIO_AI_HOME` | `~/.velxio-ai` | Folder of the AI connections list |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary |
| `VELXIO_URL` | `http://localhost:3080` | Backend used by `install_library` |
| `AI_BRIDGE_ORIGINS` | localhost:3080 / 5173 | Origins allowed to open the WebSocket |

The frontend connects to `ws://127.0.0.1:8787/ws`; override with `VITE_AI_BRIDGE_URL` at build time.

## AI connections

Who answers is chosen in the IDE: the gear next to "Answers:" in the chat
panel opens **AI connections**. The list lives in `~/.velxio-ai/connections.json`
(mode 0600, no secrets; `connections.mjs`):

- **Claude Code accounts**, as in Orca: the login the bridge runs under
  (`system`), a folder already signed in on this computer (e.g.
  `~/.claude-work`), or a new one the IDE signs in — the bridge runs
  `claude auth login` in its own folder under `~/.velxio-ai/claude/`, the IDE
  opens the sign-in link and the user pastes the code the page shows
  (`claudeAccounts.mjs`). Runs get `CLAUDE_CONFIG_DIR` of their account.
- **API connections** — Anthropic, OpenAI, OpenRouter, any OpenAI-compatible
  server, Ollama: the bridge runs the agent loop itself (`apiAgent.mjs`, one
  adapter per API in `providers/`), with the same canvas tools and the same
  events as `claude -p`. Keys live in the macOS keychain (service
  `velxio-ai`; `keyStore.mjs`; elsewhere or with `VELXIO_AI_KEYS=file`, in
  `~/.velxio-ai/api-keys.json`, mode 0600) and never go back to the IDE.
  Conversations are kept in `~/.velxio-ai/sessions/` so a chat continues
  after a reload. The card author searches the web with Anthropic's and
  OpenAI's own search tools; the other kinds get only `fetch_page`.
- **Model** per connection: Opus, Sonnet, Haiku for Claude Code; for an API
  connection, any model its provider lists.
- One connection **answers the chat**, one **writes sensor cards** (and
  identifies photos). A chat session belongs to the connection it was made
  under: switching starts a new session, the transcript stays.
- **API connections**: Anthropic, OpenAI, OpenRouter, any OpenAI-compatible
  server (address + optional key) and a local Ollama. The bridge runs the
  agent loop itself (`apiAgent.mjs`) with the same canvas tools `claude -p`
  gets, through an adapter per protocol (`providers/anthropic.mjs` — Messages
  API; `providers/openai.mjs` — Responses API; `providers/openaiChat.mjs` —
  Chat Completions for the rest). Their conversations are kept in
  `~/.velxio-ai/sessions/` so a chat continues after a reload. Keys live in the
  macOS keychain (service `velxio-ai`, `keyStore.mjs`; elsewhere or with
  `VELXIO_AI_KEYS=file`, `~/.velxio-ai/api-keys.json`, mode 0600) and never go
  back to the IDE. The card author gets the provider's own web search
  (Anthropic, OpenAI) and `fetch_page`; the other kinds only `fetch_page`.

## Test

```bash
npm test
```
