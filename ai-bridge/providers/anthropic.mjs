// Anthropic Messages API connections (an API key from console.anthropic.com),
// as an apiAgent.mjs adapter: one streamed request per turn through the
// official SDK, the canvas tools as client tools, Anthropic's own web search
// when the card author needs to research a part.
//
// Items are Messages API messages; an assistant turn is appended whole
// (thinking, server-tool and fallback blocks included), as the API expects
// the next request to carry it.
import Anthropic from '@anthropic-ai/sdk';

const MAX_TOKENS = 64_000;
/** A streamed tool input that would not parse is asked for again, at most this often in a row. */
const JSON_RETRIES = 2;

/** Models with the dynamic-filtering web search; the others take the basic variant. */
const NEW_WEB_SEARCH = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
/**
 * Models that take the server-side refusal fallback: a declined request is
 * re-run on a fallback model inside the same call instead of just stopping.
 */
const FALLBACKS = /^claude-(fable-5-1|mythos-5-1|opus-5-5|opus-5(?!-)|sonnet-5-5)/;

function client(apiKey) {
  return new Anthropic({ apiKey });
}

export function userItems(text, images = []) {
  return [
    {
      role: 'user',
      content: [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        { type: 'text', text: text || 'Look at the attached photo.' },
      ],
    },
  ];
}

export function toolResultItems(results) {
  // All results of one assistant turn go back in a single user message.
  return [
    {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.images?.length
          ? [{ type: 'text', text: r.output }, ...r.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))]
          : r.output,
        ...(r.isError ? { is_error: true } : {}),
      })),
    },
  ];
}

export async function turn({ apiKey, model, system, items, tools, webSearch, onText, signal }) {
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: items,
    tools: [
      ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, eager_input_streaming: true })),
      ...(webSearch
        ? [{ type: NEW_WEB_SEARCH.test(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 8 }]
        : []),
    ],
    ...(FALLBACKS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };
  let message;
  for (let attempt = 0; ; attempt++) {
    const stream = client(apiKey).beta.messages.stream(params, { signal });
    stream.on('text', (delta) => onText(delta));
    try {
      message = await stream.finalMessage();
      break;
    } catch (err) {
      // With eager input streaming a tool input that cannot be parsed at all
      // rejects here; only that is asked again, API errors go up.
      if (err instanceof Anthropic.APIError || signal?.aborted || attempt >= JSON_RETRIES) throw err;
    }
  }

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = message.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
  const stop =
    message.stop_reason === 'tool_use'
      ? 'tools'
      : message.stop_reason === 'pause_turn'
        ? 'pause'
        : message.stop_reason === 'refusal'
          ? 'refused'
          : message.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'end';
  return { append: [{ role: 'assistant', content: message.content }], text, toolCalls, stop };
}

export async function listModels({ apiKey, signal }) {
  const out = [];
  for await (const m of client(apiKey).models.list({ limit: 100 }, { signal })) out.push({ id: m.id, label: m.display_name ?? m.id });
  return out;
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key may not use that model.';
  if (err instanceof Anthropic.NotFoundError) return 'Anthropic does not know that model — pick another in AI connections.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached — wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Anthropic refused the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Cannot reach api.anthropic.com.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err?.message ?? String(err);
}
