// Spawns `claude -p` in headless stream-json mode and turns its event stream
// into the small set of events the IDE chat panel renders.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const MCP_PREFIX = 'mcp__velxio__';

export function buildClaudeArgs({ mcpUrl, systemPrompt, model, sessionId }) {
  const mcpConfig = { mcpServers: { velxio: { type: 'http', url: mcpUrl } } };
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // No built-in tools (Bash, file access...) — the agent only gets the canvas tools.
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--allowedTools', 'mcp__velxio',
    '--system-prompt', systemPrompt,
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

// Maps one parsed stream-json line to zero or more UI events.
export function mapStreamEvent(e) {
  switch (e.type) {
    case 'system':
      return e.subtype === 'init' ? [{ type: 'session', sessionId: e.session_id, model: e.model }] : [];
    case 'stream_event': {
      const ev = e.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return [{ type: 'text_delta', text: ev.delta.text }];
      }
      return [];
    }
    case 'assistant': {
      const out = [];
      for (const block of e.message?.content ?? []) {
        if (block.type === 'text' && block.text) out.push({ type: 'assistant_text', text: block.text });
        if (block.type === 'tool_use') {
          out.push({ type: 'tool_use', id: block.id, name: stripPrefix(block.name), input: block.input });
        }
      }
      return out;
    }
    case 'user': {
      const out = [];
      const content = e.message?.content;
      if (!Array.isArray(content)) return out;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        out.push({
          type: 'tool_result',
          id: block.tool_use_id,
          isError: !!block.is_error,
          preview: previewOf(block.content),
        });
      }
      return out;
    }
    case 'result':
      return [
        {
          type: 'result',
          isError: !!e.is_error,
          subtype: e.subtype,
          text: e.result ?? '',
          costUsd: e.total_cost_usd,
          durationMs: e.duration_ms,
          numTurns: e.num_turns,
          sessionId: e.session_id,
        },
      ];
    default:
      return [];
  }
}

function stripPrefix(name) {
  return name?.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

function previewOf(content) {
  const text = Array.isArray(content)
    ? content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
    : String(content ?? '');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// Runs one prompt. Resolves when the process exits; `onEvent` receives UI events.
export function runClaude({ bin = 'claude', args, prompt, cwd, env, onEvent }) {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderrTail = '';
  let sawResult = false;

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    for (const ev of mapStreamEvent(parsed)) {
      if (ev.type === 'result') sawResult = true;
      onEvent(ev);
    }
  });

  // The prompt goes over stdin so it can never be mistaken for a flag value.
  child.stdin.end(prompt);

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      onEvent({ type: 'error', message: `Failed to start ${bin}: ${err.message}` });
      resolve({ code: -1 });
    });
    child.on('close', (code, signal) => {
      if (!sawResult && signal !== 'SIGTERM') {
        onEvent({ type: 'error', message: `claude exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}` });
      }
      resolve({ code, signal });
    });
  });

  return { child, done };
}
