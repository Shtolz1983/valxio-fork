// The agent loop for connections that talk to a model API with a key
// (Anthropic, OpenAI, OpenRouter, any OpenAI-compatible server, Ollama),
// where no CLI agent runs the loop: the bridge sends the conversation, runs
// the tools the model asks for (the same canvas tools `claude -p` gets over
// MCP) and sends their results back until the model is done.
//
// It speaks to the tab exactly as claudeRunner.mjs does — the same events
// (session, text_delta, assistant_text, tool_use, tool_result, result, error)
// and the same { child.kill(), done } handle — so the chat, the card author
// and the photo identification do not care which kind answers.
//
// Provider adapter contract (providers/*.mjs), all in the provider's own
// message format ("items" below), which the session store keeps as is:
//
//   userItems(text, images)  -> items      images: [{ mediaType, data (base64) }]
//   toolResultItems(results) -> items      results: [{ id, name, output (string), isError, images }]
//                                           images: [{ mediaType, data }], usually empty
//   async turn({ conn, apiKey, model, system, items, tools, webSearch, onText, signal })
//     -> { append: items, text, toolCalls: [{ id, name, input }], stop }
//        tools: [{ name, description, schema (JSON Schema) }]
//        toolCalls[].input: the parsed object, or the raw string when it would not parse
//        stop: 'end' | 'tools' | 'pause' (call again as is) | 'refused' | 'max_tokens'
//        Throws on a failed request; describeError(err) turns that into a sentence.
//   async listModels({ conn, apiKey, signal }) -> [{ id, label }]
//   describeError(err) -> string
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_TURNS = 40;

/**
 * A tool's result may carry pictures for the model under this key (a symbol,
 * so JSON.stringify leaves them out of the text): [{ mediaType, data (base64) }].
 */
export const TOOL_IMAGES = Symbol('tool images');
const PREVIEW_CHARS = 400;

function preview(text) {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/**
 * The tools of a run in both forms: the JSON Schema the model sees and the
 * zod object that checks what it sends back (a streamed input can come back
 * cut short or malformed; such a call gets an error result, not a run).
 * `defs`: [{ name, description, input (zod shape), execute(args) }].
 */
export function toolSet(defs) {
  return defs.map((d) => {
    const object = z.object(d.input ?? {});
    const { $schema, ...schema } = z.toJSONSchema(object);
    return { name: d.name, description: d.description, schema, check: (x) => object.safeParse(x ?? {}), execute: d.execute };
  });
}

/**
 * Run one prompt. `sessions` is the store of conversations (apiSessions.mjs);
 * `sessionId` continues one, null starts one. `tools` from toolSet().
 */
export function runApiAgent({ provider, conn, apiKey, system, sessions, sessionId, prompt, images = [], tools = [], webSearch = false, onEvent }) {
  const abort = new AbortController();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const advertised = tools.map(({ name, description, schema }) => ({ name, description, schema }));

  const done = (async () => {
    let id = sessionId;
    let items = [];
    if (id) {
      const saved = sessions.load(id);
      if (!saved || saved.kind !== conn.kind) {
        // As `claude -p --resume` of an unknown session: nothing ran, the
        // bridge starts the prompt again in a new session.
        onEvent({ type: 'result', isError: true, sessionLost: true, text: '', numTurns: 0 });
        return { code: 1 };
      }
      items = saved.items;
    } else {
      id = randomUUID();
    }
    onEvent({ type: 'session', sessionId: id, model: conn.model });
    items.push(...provider.userItems(prompt, images));
    const save = () => sessions.save(id, { kind: conn.kind, model: conn.model, items });

    let lastText = '';
    let turns = 0;
    try {
      for (; turns < MAX_TURNS; turns++) {
        const r = await provider.turn({
          conn,
          apiKey,
          model: conn.model,
          system,
          items,
          tools: advertised,
          webSearch,
          onText: (text) => onEvent({ type: 'text_delta', text }),
          signal: abort.signal,
        });
        items.push(...r.append);
        save();
        if (r.text) {
          lastText = r.text;
          onEvent({ type: 'assistant_text', text: r.text });
        }
        if (r.stop === 'pause') continue;
        if (r.stop === 'refused') {
          onEvent({ type: 'result', isError: true, subtype: 'refusal', text: 'The model declined this request.', numTurns: turns + 1, sessionId: id });
          return { code: 1 };
        }
        if (r.stop === 'max_tokens' && r.toolCalls.length) throw new Error('The answer was cut off by the output limit in the middle of a tool call.');
        if (r.stop !== 'tools' || !r.toolCalls.length) break;

        const results = [];
        for (const call of r.toolCalls) {
          onEvent({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          const result = await runTool(byName.get(call.name), call, abort.signal);
          onEvent({ type: 'tool_result', id: call.id, isError: result.isError, preview: preview(result.output) });
          results.push(result);
        }
        items.push(...provider.toolResultItems(results));
        save();
        if (abort.signal.aborted) break;
      }
      onEvent({ type: 'result', isError: false, subtype: 'success', text: lastText, numTurns: turns + 1, sessionId: id });
      return { code: 0 };
    } catch (err) {
      save();
      if (abort.signal.aborted) {
        onEvent({ type: 'result', isError: false, subtype: 'cancelled', text: lastText, numTurns: turns, sessionId: id });
        return { code: 143 };
      }
      onEvent({ type: 'error', message: provider.describeError(err) });
      onEvent({ type: 'result', isError: true, subtype: 'error', text: '', numTurns: turns, sessionId: id });
      return { code: 1 };
    }
  })();

  return { child: { kill: () => abort.abort() }, done };
}

async function runTool(tool, call, signal) {
  const fail = (output) => ({ id: call.id, name: call.name, output, isError: true, images: [] });
  if (signal.aborted) return fail('Stopped by the user.');
  if (!tool) return fail(`There is no tool "${call.name}".`);
  // An adapter passes arguments it could not parse as the raw string.
  if (typeof call.input === 'string') return fail(`The arguments were not valid JSON: ${preview(call.input)}`);
  const parsed = tool.check(call.input);
  if (!parsed.success) {
    return fail(`The arguments do not match the tool: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  }
  try {
    const value = await tool.execute(parsed.data);
    const output = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true }, null, 2);
    return { id: call.id, name: call.name, output, isError: false, images: value?.[TOOL_IMAGES] ?? [] };
  } catch (err) {
    return fail(`Error: ${err.message}`);
  }
}
