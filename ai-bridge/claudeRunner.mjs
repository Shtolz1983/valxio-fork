// Spawns `claude -p` in headless stream-json mode and turns its event stream
// into the small set of events the IDE chat panel renders.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const MCP_PREFIX = 'mcp__velxio__';

/** Reply languages the IDE panel offers (code → name the model understands). */
export const REPLY_LANGUAGES = {
  ru: 'Russian',
  en: 'English',
  uk: 'Ukrainian',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  zh: 'Simplified Chinese',
};

/** The system prompt with the reply-language rule for `language`, if known. */
export function withReplyLanguage(systemPrompt, language) {
  const name = REPLY_LANGUAGES[language];
  if (!name) return systemPrompt;
  return `${systemPrompt}\n\n## Reply language\n\nAlways write your messages to the user in ${name}, whatever language the request, the code or earlier messages are in. Code, identifiers and part ids stay as they are.\n`;
}

/** Photo formats the model takes, and the limits the bridge enforces. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MAX_IMAGES = 4;
/** Base64 characters per image: about 5 MB of image, the API's own cap. */
export const MAX_IMAGE_B64 = 6_900_000;

/**
 * Photos as the browser sends them ({ mediaType, data: base64 }), checked.
 * Throws with a message the user can act on.
 */
export function sanitizeImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('images must be a list');
  if (raw.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} photos per message`);
  return raw.map((img, i) => {
    const mediaType = String(img?.mediaType ?? '');
    const data = String(img?.data ?? '');
    if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`photo ${i + 1}: ${mediaType || 'unknown'} is not JPEG, PNG, WebP or GIF`);
    if (!data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(data)) {
      throw new Error(`photo ${i + 1}: empty, broken or larger than 5 MB`);
    }
    return { mediaType, data };
  });
}

/** One user message with photos, as `--input-format stream-json` reads it. */
export function userMessageLine(text, images) {
  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text },
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/**
 * `tools`: built-in Claude Code tools to enable ("" = none — the chat gets
 * only the canvas tools; the card author gets "WebSearch,WebFetch").
 * `allowedTools`: what runs without a permission prompt.
 */
export function buildClaudeArgs({
  mcpUrl,
  systemPrompt,
  model,
  sessionId,
  tools = '',
  allowedTools = 'mcp__velxio',
  streamInput = false,
}) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // No built-in tools (Bash, file access...) unless asked for: the chat
    // agent only gets the canvas tools.
    '--tools', tools,
    '--setting-sources', '',
    // No mcpUrl: a run with no MCP server at all (the photo identification).
    '--strict-mcp-config',
    ...(mcpUrl ? ['--mcp-config', JSON.stringify({ mcpServers: { velxio: { type: 'http', url: mcpUrl } } })] : []),
    '--allowedTools', allowedTools,
    '--system-prompt', systemPrompt,
    // The reply language can change between turns of one conversation; the
    // default snapshot would replay the first turn's system prompt on --resume.
    '--system-prompt-snapshot', 'off',
  ];
  // Photos travel as content blocks of a stream-json user message.
  if (streamInput) args.push('--input-format', 'stream-json');
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
          // --resume of a session Claude no longer has: nothing ran.
          sessionLost:
            !!e.is_error && Array.isArray(e.errors) && e.errors.some((m) => /No conversation found/i.test(String(m))),
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
// With `images`, `args` must come from buildClaudeArgs({ streamInput: true }).
export function runClaude({ bin = 'claude', args, prompt, images = [], cwd, env, onEvent }) {
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
  child.stdin.end(images.length ? userMessageLine(prompt, images) : prompt);

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      onEvent({ type: 'error', message: `Failed to start ${bin}: ${err.message}` });
      resolve({ code: -1 });
    });
    child.on('close', (code, signal) => {
      // A stop (cancel, reset, closed tab) is SIGTERM; claude may also exit
      // on it by itself with 128 + 15.
      const stopped = signal === 'SIGTERM' || code === 143;
      if (!sawResult && !stopped) {
        onEvent({ type: 'error', message: `claude exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}` });
      }
      resolve({ code, signal });
    });
  });

  return { child, done };
}
