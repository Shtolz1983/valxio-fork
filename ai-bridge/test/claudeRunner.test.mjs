import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, mapStreamEvent } from '../claudeRunner.mjs';

test('buildClaudeArgs disables built-in tools and wires the MCP server', () => {
  const args = buildClaudeArgs({ mcpUrl: 'http://127.0.0.1:8787/mcp', systemPrompt: 'SP', model: 'sonnet' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SP');
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), {
    mcpServers: { velxio: { type: 'http', url: 'http://127.0.0.1:8787/mcp' } },
  });
  assert.ok(!args.includes('--resume'));
});

test('buildClaudeArgs resumes an existing session', () => {
  const args = buildClaudeArgs({ mcpUrl: 'u', systemPrompt: 's', sessionId: 'abc' });
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
});

test('mapStreamEvent: init, text delta, tool use, tool result, result', () => {
  assert.deepEqual(mapStreamEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }), [
    { type: 'session', sessionId: 's1', model: 'm' },
  ]);
  assert.deepEqual(
    mapStreamEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }),
    [{ type: 'text_delta', text: 'Hi' }],
  );
  assert.deepEqual(
    mapStreamEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__velxio__connect', input: { from: 'a:1', to: 'b:2' } }] },
    }),
    [{ type: 'tool_use', id: 't1', name: 'connect', input: { from: 'a:1', to: 'b:2' } }],
  );
  assert.deepEqual(
    mapStreamEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Error: no pin' }] }] },
    }),
    [{ type: 'tool_result', id: 't1', isError: true, preview: 'Error: no pin' }],
  );
  const [res] = mapStreamEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, session_id: 's1' });
  assert.equal(res.type, 'result');
  assert.equal(res.text, 'done');
  assert.equal(res.sessionId, 's1');
});

test('mapStreamEvent ignores unrelated events', () => {
  assert.deepEqual(mapStreamEvent({ type: 'rate_limit_event' }), []);
  assert.deepEqual(mapStreamEvent({ type: 'system', subtype: 'thinking_tokens' }), []);
});
