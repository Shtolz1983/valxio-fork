// Connections that speak the Chat Completions API — OpenRouter, any
// OpenAI-compatible server (LM Studio, vLLM, llama.cpp, LiteLLM, …) and a
// local Ollama — as an apiAgent.mjs adapter: one streamed request per turn
// through the official `openai` SDK pointed at the server's baseURL.
//
// Items are Chat Completions messages: user messages, the assistant message
// of each turn (text plus tool_calls) and role:'tool' results. The system
// prompt is not an item: it comes with every turn and goes first.
//
// No built-in web search here (servers differ, most have none); the flag is
// ignored and the model answers from what it knows.
//
// Reasoning models: the reasoning a server streams (OpenRouter's `reasoning`
// and `reasoning_details`, DeepSeek/Kimi's `reasoning_content`, Ollama's
// `reasoning`) is kept on the assistant message under the same field and
// sent back, as these servers ask for in a tool loop (Gemini via OpenRouter
// refuses a tool result without the reasoning_details of its call).
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { SetupError, apiMessage, checkAborted, describeOpenAIError, errorContext, parseArguments, withContext } from './openai.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';

/** The server and key of a connection; the SDK insists on a key, keyless servers get a placeholder. */
function endpoint(conn, apiKey) {
  switch (conn.kind) {
    case 'openrouter':
      if (!apiKey) throw new SetupError('No API key is set for this connection.');
      return { baseURL: conn.baseUrl || OPENROUTER_URL, apiKey }; // baseUrl: a proxy, or the tests' server
    case 'ollama':
      return { baseURL: conn.baseUrl || OLLAMA_URL, apiKey: apiKey || 'ollama' }; // Ollama ignores the key
    case 'openai-compatible':
      if (!conn.baseUrl) throw new SetupError('This connection has no server address.');
      return { baseURL: conn.baseUrl, apiKey: apiKey || 'not-needed' };
    default:
      throw new SetupError(`Connection kind "${conn.kind}" does not speak Chat Completions.`);
  }
}

function client(conn, apiKey) {
  return new OpenAI(endpoint(conn, apiKey));
}

const DEFAULT_URL = { openrouter: OPENROUTER_URL, ollama: OLLAMA_URL };

function context(conn, model) {
  return { baseURL: conn.baseUrl || DEFAULT_URL[conn.kind], kind: conn.kind, model };
}

export function userItems(text, images = []) {
  // A plain string when there is no image: some local servers take nothing else.
  if (!images.length) return [{ role: 'user', content: text }];
  const content = [{ type: 'text', text }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
  return [{ role: 'user', content }];
}

export function toolResultItems(results) {
  // No error flag in this API; runTool's error outputs say so in words.
  const items = results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.output }));
  // A tool message takes text only: pictures follow in a user message.
  const withImages = results.filter((r) => r.images?.length);
  if (withImages.length) {
    const names = withImages.map((r) => r.name).join(', ');
    items.push(...userItems(`Images returned by ${names}.`, withImages.flatMap((r) => r.images)));
  }
  return items;
}

function functionTool(t) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } };
}

/**
 * OpenRouter streams reasoning_details in fragments; fragments of one block
 * share its index (or follow each other with the same type) and are joined.
 */
function mergeDetails(list, fragment) {
  const last = list.at(-1);
  const same = last && last.type === fragment.type && (fragment.index === undefined || last.index === fragment.index);
  if (!same) {
    list.push({ ...fragment });
    return;
  }
  for (const [k, v] of Object.entries(fragment)) {
    if (v == null) continue;
    if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string' && typeof last[k] === 'string') last[k] += v;
    else last[k] = v;
  }
}

/** The tool call a delta fragment belongs to: by index, or by id when a server sends none. */
function callSlot(calls, tc) {
  if (tc.index !== undefined) return (calls[tc.index] ??= { id: '', name: '', arguments: '' });
  const last = calls.at(-1);
  if (last && (!tc.id || tc.id === last.id)) return last;
  const slot = { id: '', name: '', arguments: '' };
  calls.push(slot);
  return slot;
}

export async function turn({ conn, apiKey, model, system, items, tools = [], onText, signal }) {
  return withContext(context(conn, model), async () => {
    const messages = system ? [{ role: 'system', content: system }, ...items] : items;
    const stream = await client(conn, apiKey).chat.completions.create(
      { model, messages, tools: tools.length ? tools.map(functionTool) : undefined, stream: true },
      { signal },
    );

    let text = '';
    let refusal = '';
    let finish = null;
    const calls = [];
    const reasoning = {}; // reasoning / reasoning_content strings, as the server named them
    const details = [];
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue; // a usage-only chunk
      const d = choice.delta ?? {};
      if (d.content) {
        text += d.content;
        onText?.(d.content);
      }
      if (d.refusal) refusal += d.refusal;
      for (const key of ['reasoning', 'reasoning_content']) {
        if (typeof d[key] === 'string' && d[key]) reasoning[key] = (reasoning[key] ?? '') + d[key];
      }
      if (Array.isArray(d.reasoning_details)) for (const f of d.reasoning_details) mergeDetails(details, f);
      for (const tc of d.tool_calls ?? []) {
        const slot = callSlot(calls, tc);
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    checkAborted(signal);
    if (finish === 'error') throw new Error('The provider ended the answer with an error.'); // OpenRouter

    const toolCalls = [];
    const assistantCalls = [];
    for (const c of calls.filter(Boolean)) {
      const id = c.id || `call_${randomUUID()}`; // some local servers send none
      const parsed = parseArguments(c.arguments);
      toolCalls.push({ id, name: c.name, input: parsed.input });
      // Broken arguments go back as "{}": servers such as Ollama parse them and would reject every later turn.
      assistantCalls.push({ id, type: 'function', function: { name: c.name, arguments: parsed.ok ? c.arguments || '{}' : '{}' } });
    }

    const message = { role: 'assistant', content: text || (assistantCalls.length ? null : '') };
    if (assistantCalls.length) message.tool_calls = assistantCalls;
    if (refusal) message.refusal = refusal;
    Object.assign(message, reasoning);
    if (details.length) message.reasoning_details = details;

    let stop;
    if (finish === 'length') stop = 'max_tokens';
    else if (finish === 'content_filter' || (refusal && !text && !toolCalls.length)) stop = 'refused';
    // Some servers end a tool call with finish_reason "stop" (older Ollama), so the calls decide.
    else if (toolCalls.length) stop = 'tools';
    else stop = 'end';
    return { append: [message], text, toolCalls, stop };
  });
}

export async function listModels({ conn, apiKey, signal }) {
  return withContext(context(conn), async () => {
    // OpenRouter lists its models to anyone: ask about the key itself, so
    // "check and load" rejects a wrong key here and not at the first prompt.
    if (conn.kind === 'openrouter') await client(conn, apiKey).get('/key', { signal });
    const page = await client(conn, apiKey).models.list({ signal });
    let models = page.data.filter((m) => typeof m?.id === 'string');
    if (conn.kind === 'openrouter') {
      // Hundreds of models; the agent needs tools and text out, OpenRouter says which have them.
      models = models.filter(
        (m) =>
          (!Array.isArray(m.supported_parameters) || m.supported_parameters.includes('tools')) &&
          (!Array.isArray(m.architecture?.output_modalities) || m.architecture.output_modalities.includes('text')),
      );
    }
    return models
      .map((m) => ({ id: m.id, label: typeof m.name === 'string' && m.name ? m.name : m.id }))
      .sort((a, b) => a.label.localeCompare(b.label)); // OpenRouter names start with the vendor, so they group
  });
}

export function describeError(err) {
  const { kind, baseURL, model } = errorContext(err);
  if (kind === 'ollama') {
    // Ollama answers 400 "<model> does not support tools" for a model without tool calling;
    // no error code tells it apart from other 400s, so its text does.
    if (err instanceof OpenAI.BadRequestError && /does not support tools/i.test(apiMessage(err))) {
      return 'This model does not support tools — pick another (e.g. qwen2.5, llama3.1).';
    }
    if (err instanceof OpenAI.NotFoundError && model) return `Model "${model}" is not in Ollama — run "ollama pull ${model}" or pick another.`;
    if (err instanceof OpenAI.APIConnectionError && !(err instanceof OpenAI.APIConnectionTimeoutError)) {
      return `Cannot reach Ollama at ${baseURL} — is it running?`;
    }
  }
  if (kind === 'openrouter' && err instanceof OpenAI.APIError && err.status === 402) {
    return 'The OpenRouter account has run out of credit.';
  }
  return describeOpenAIError(err);
}
