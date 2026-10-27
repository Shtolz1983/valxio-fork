// OpenAI connections (an API key from platform.openai.com), as an
// apiAgent.mjs adapter: one streamed Responses API request per turn through
// the official SDK, the canvas tools as function tools, OpenAI's built-in web
// search when the card author needs to research a part.
//
// Items are Responses API input/output items, kept as the API returned them:
// a turn appends its output items (reasoning, messages, function calls, web
// search calls) and tool results go back as function_call_output items.
//
// Stateless: every request carries the whole history with `store: false`, so
// nothing lives on OpenAI's side and a session survives a key change. That has
// two consequences for reasoning models (o-series, gpt-5), which need their
// reasoning items back in a tool loop:
//   - `include: ['reasoning.encrypted_content']` makes the API return the
//     reasoning as an opaque blob the next request can carry;
//   - item ids are dropped when sending: with store:false an id refers to an
//     item the server never kept ("Item with id 'rs_…' not found"); the
//     encrypted content is what the model reads back.
//
// The error describer and the error context below are shared with
// openaiChat.mjs, which speaks the same SDK to other servers.
import OpenAI from 'openai';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// ── Errors ──────────────────────────────────────────────────────────────────

// describeError(err) gets only the error, but a good sentence names the
// server and the model; the request that failed leaves them here.
const contexts = new WeakMap();

/** Run `fn`, tagging what it throws with { baseURL, kind, model }. */
export async function withContext(ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object') contexts.set(err, ctx);
    throw err;
  }
}

export function errorContext(err) {
  return (err && typeof err === 'object' && contexts.get(err)) || {};
}

/** The response ended as `failed`, or the stream sent an `error` event. */
export class ResponseFailedError extends Error {
  constructor(error) {
    super(error?.message || 'The response failed.');
    this.code = error?.code ?? null;
  }
}

/** A missing key or server address, found before any request. */
export class SetupError extends Error {}

const MESSAGE_MAX = 200;

/** What the server said, without the SDK's "400 " prefix. */
export function apiMessage(err) {
  const e = err?.error;
  const text = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : '';
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text;
}

function withDetail(sentence, detail) {
  return detail ? `${sentence} (${detail})` : sentence;
}

/** A short English sentence for the chat about a failed request. */
export function describeOpenAIError(err) {
  const { baseURL = OPENAI_BASE_URL, model } = errorContext(err);
  const said = apiMessage(err);
  if (err instanceof SetupError) return err.message;
  if (err instanceof ResponseFailedError) return withDetail('The model could not finish the answer', err.message);
  if (err instanceof OpenAI.APIUserAbortError) return 'The request was stopped.';
  // Timeout first: it is a subclass of the connection error.
  if (err instanceof OpenAI.APIConnectionTimeoutError) return `${baseURL} did not answer in time.`;
  if (err instanceof OpenAI.APIConnectionError) return `Cannot reach ${baseURL}.`;
  if (err instanceof OpenAI.AuthenticationError) return 'The API key was rejected.';
  if (err instanceof OpenAI.PermissionDeniedError) return withDetail('The API key has no access to this model or feature', said);
  if (err instanceof OpenAI.NotFoundError) return model ? `Model "${model}" not found at ${baseURL}.` : `Not found at ${baseURL}.`;
  if (err instanceof OpenAI.RateLimitError) {
    return err.code === 'insufficient_quota'
      ? 'The account has run out of credit — check its billing.'
      : 'Too many requests for this key right now — wait a moment and try again.';
  }
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
    if (err.code === 'context_length_exceeded') return 'The conversation is too long for this model — start a new chat.';
    return withDetail('The request was rejected', said);
  }
  if (err instanceof OpenAI.InternalServerError) return 'The provider had a server error — try again in a moment.';
  if (err instanceof OpenAI.APIError) {
    // A status outside the typed classes, or an error event in the middle of a stream (no status).
    return withDetail(err.status ? `The provider answered with error ${err.status}` : 'The provider reported an error', said);
  }
  if (err instanceof OpenAI.OpenAIError) return withDetail('The request failed', err.message);
  return err?.message || String(err);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * A tool call's arguments as the input apiAgent checks. Arguments the model
 * sent as broken JSON (cut off, or not JSON at all) come back as the raw
 * string: apiAgent's zod check fails on a non-object, so the call gets an
 * error result the model can read and retry, and the run goes on. (An object
 * with a marker key would not do: zod drops unknown keys, and a tool without
 * required arguments would then run with none.)
 */
export function parseArguments(raw) {
  if (raw == null || raw === '') return { ok: true, input: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, input: value };
  } catch {
    // fall through
  }
  return { ok: false, input: String(raw) };
}

const dataUrl = (img) => `data:${img.mediaType};base64,${img.data}`;

/** Throw if the run was stopped: the SDK ends an aborted stream quietly instead of throwing. */
export function checkAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new OpenAI.APIUserAbortError();
}

// ── Adapter ─────────────────────────────────────────────────────────────────

// conn.baseUrl, when a connection has one, points at a proxy (or the tests' server).
const baseOf = (conn) => conn?.baseUrl || OPENAI_BASE_URL;

function client(conn, apiKey) {
  if (!apiKey) throw new SetupError('No API key is set for this connection.');
  // baseURL given explicitly so OPENAI_BASE_URL in the bridge's environment cannot redirect the key.
  return new OpenAI({ apiKey, baseURL: baseOf(conn) });
}

export function userItems(text, images = []) {
  const content = [{ type: 'input_text', text }];
  for (const img of images) content.push({ type: 'input_image', image_url: dataUrl(img), detail: 'auto' });
  return [{ type: 'message', role: 'user', content }];
}

export function toolResultItems(results) {
  // The Responses API has no error flag on a tool result; runTool's error outputs say so in words.
  return results.map((r) => ({
    type: 'function_call_output',
    call_id: r.id,
    output: r.images?.length
      ? [{ type: 'input_text', text: r.output }, ...r.images.map((img) => ({ type: 'input_image', image_url: dataUrl(img), detail: 'auto' }))]
      : r.output,
  }));
}

/** Items as sent with store:false: without the ids of items the server did not keep. */
function forRequest(items) {
  return items.map(({ id, ...rest }) => rest);
}

function functionTool(t) {
  // strict:false — strict mode wants every property required and additionalProperties:false,
  // which the tools' optional arguments do not satisfy.
  return { type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false };
}

export async function turn({ conn, apiKey, model, system, items, tools = [], webSearch, onText, signal }) {
  return withContext({ baseURL: baseOf(conn), kind: 'openai', model }, async () => {
    const requestTools = tools.map(functionTool);
    if (webSearch) requestTools.push({ type: 'web_search' });
    const stream = await client(conn, apiKey).responses.create(
      {
        model,
        instructions: system || undefined,
        input: forRequest(items),
        tools: requestTools.length ? requestTools : undefined,
        store: false,
        include: ['reasoning.encrypted_content'],
        stream: true,
      },
      { signal },
    );

    const done = []; // output items by output_index, complete (with encrypted reasoning)
    let response = null;
    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) onText?.(ev.delta);
          break;
        case 'response.output_item.done':
          done[ev.output_index] = ev.item;
          break;
        case 'response.completed':
        case 'response.incomplete':
          response = ev.response;
          break;
        case 'response.failed':
          throw new ResponseFailedError(ev.response?.error);
        case 'error':
          throw new ResponseFailedError(ev);
        default:
          break;
      }
    }
    checkAborted(signal);
    if (!response) throw new ResponseFailedError({ message: 'the answer stream ended early' });

    const output = done.some(Boolean) ? done.filter(Boolean) : (response.output ?? []);
    const messages = output.filter((i) => i.type === 'message');
    const parts = messages.flatMap((m) => m.content ?? []);
    const text = messages
      .map((m) => (m.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join(''))
      .filter(Boolean)
      .join('\n\n');
    const toolCalls = output
      .filter((i) => i.type === 'function_call')
      .map((i) => ({ id: i.call_id, name: i.name, input: parseArguments(i.arguments).input }));

    let stop;
    if (response.status === 'incomplete') {
      stop = response.incomplete_details?.reason === 'content_filter' ? 'refused' : 'max_tokens';
    } else if (response.status === 'completed') {
      const refused = parts.some((c) => c.type === 'refusal') && !text;
      stop = toolCalls.length ? 'tools' : refused ? 'refused' : 'end';
    } else {
      throw new ResponseFailedError({ message: `the response ended as "${response.status}"` });
    }
    return { append: output, text, toolCalls, stop };
  });
}

// Model ids that are not chat models for the Responses API.
const NOT_CHAT = /embedding|audio|realtime|transcribe|tts|whisper|image|dall-e|moderation|search|computer-use|davinci|babbage|instruct/;
const CHAT = /^(gpt-|o\d|chatgpt-|codex-)/;

export async function listModels({ conn, apiKey, signal }) {
  return withContext({ baseURL: baseOf(conn), kind: 'openai' }, async () => {
    const page = await client(conn, apiKey).models.list({ signal });
    return page.data
      .filter((m) => CHAT.test(m.id) && !NOT_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id)) // newest first
      .map((m) => ({ id: m.id, label: m.id }));
  });
}

export function describeError(err) {
  return describeOpenAIError(err);
}
