import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, sanitizeImages, userMessageLine } from '../claudeRunner.mjs';
import { buildIdentifyPrompt, parseIdentification } from '../identify.mjs';

const PNG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

test('photos are checked before they reach claude', () => {
  assert.deepEqual(sanitizeImages(undefined), []);
  assert.deepEqual(sanitizeImages([PNG]), [PNG]);
  assert.throws(() => sanitizeImages([{ mediaType: 'image/heic', data: 'AAAA' }]), /not JPEG, PNG/);
  assert.throws(() => sanitizeImages([{ mediaType: 'image/png', data: 'not base64!' }]), /broken/);
  assert.throws(() => sanitizeImages([PNG, PNG, PNG, PNG, PNG]), /at most 4/);
  assert.throws(() => sanitizeImages({}), /list/);
});

test('a message with photos is one stream-json user line, photos first', () => {
  const line = userMessageLine('What is this?', [PNG]);
  assert.ok(line.endsWith('\n'));
  const msg = JSON.parse(line);
  assert.equal(msg.type, 'user');
  assert.deepEqual(msg.message.content.map((b) => b.type), ['image', 'text']);
  assert.deepEqual(msg.message.content[0].source, { type: 'base64', media_type: 'image/png', data: PNG.data });
});

test('stream input and a run without MCP servers', () => {
  const args = buildClaudeArgs({ systemPrompt: 'x', streamInput: true, allowedTools: '' });
  assert.ok(args.includes('--input-format'));
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!buildClaudeArgs({ mcpUrl: 'http://x', systemPrompt: 'x' }).includes('--input-format'));
});

test('the identification answer is parsed and kept to catalogue ids', () => {
  const text =
    'Here it is:\n```json\n' +
    JSON.stringify({
      candidates: [
        { model: 'BME280', title: 'GY-BME280', confidence: 'high', evidence: 'silkscreen', catalogId: 'bme280', pins: ['VIN', 'GND', 'SCL', 'SDA'] },
        { model: 'BMP280', confidence: 'sure', catalogId: 'made-up' },
        { title: 'no model' },
      ],
      question: 'Is there a humidity port?',
    }) +
    '\n```';
  const r = parseIdentification(text, ['bme280', 'bmp280']);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates[0].pins, ['VIN', 'GND', 'SCL', 'SDA']);
  assert.equal(r.candidates[1].confidence, 'low');
  assert.equal(r.candidates[1].catalogId, null);
  assert.equal(r.question, 'Is there a humidity port?');
  assert.deepEqual(parseIdentification('{"candidates":[],"notAModule":"a cat"}').notAModule, 'a cat');
  assert.throws(() => parseIdentification('no idea'), /did not answer/);
  assert.throws(() => parseIdentification('{"candidates":[]}'), /named no module/);
});

test('the identification prompt lists the catalogue and the reply language', () => {
  const p = buildIdentifyPrompt('BASE', [{ id: 'bme280', name: 'BME280', title: 'T/H/P' }], 'ru');
  assert.match(p, /- bme280 — BME280 — T\/H\/P/);
  assert.match(p, /Russian/);
});
