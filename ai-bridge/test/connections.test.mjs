import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConnectionStore, connectionBaseUrl, connectionEnv } from '../connections.mjs';
import { loginUrl } from '../claudeAccounts.mjs';

const home = () => mkdtempSync(path.join(os.tmpdir(), 'velxio-ai-test-'));

test('a fresh install has the system Claude login for both roles', () => {
  const s = new ConnectionStore({ home: home(), systemModel: 'opus' });
  assert.deepEqual(s.list().map((c) => [c.id, c.kind, c.model]), [['system', 'claude-code', 'opus']]);
  assert.equal(s.selected('chat').id, 'system');
  assert.equal(s.selected('cards').id, 'system');
  assert.deepEqual(connectionEnv(s.selected('chat')), {});
});

test('accounts: a new managed folder, or an existing one; choices survive a restart', () => {
  const h = home();
  const s = new ConnectionStore({ home: h });
  const work = mkdtempSync(path.join(os.tmpdir(), 'claude-work-'));
  const a = s.add({ kind: 'claude-code', label: 'Work', model: 'opus', configDir: work });
  const b = s.add({ kind: 'claude-code', label: '  ', model: 'nope' });
  assert.equal(a.configDir, work);
  assert.equal(a.managed, false);
  assert.equal(b.label, 'Claude Code');
  assert.equal(b.model, 'sonnet');
  assert.ok(b.managed && existsSync(b.configDir) && b.configDir.startsWith(h));
  s.select('chat', a.id);
  s.update(b.id, { model: 'haiku', label: 'Personal' });
  s.select('cards', b.id);

  const again = new ConnectionStore({ home: h });
  assert.equal(again.selected('chat').label, 'Work');
  assert.deepEqual(connectionEnv(again.selected('chat')), { CLAUDE_CONFIG_DIR: work });
  assert.equal(again.selected('cards').model, 'haiku');
  assert.equal(statSync(path.join(h, 'connections.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path.join(h, 'connections.json'), 'utf8').includes('key'));
});

test('removing: a managed folder goes, a brought one stays, the selection falls back', () => {
  const s = new ConnectionStore({ home: home() });
  const work = mkdtempSync(path.join(os.tmpdir(), 'claude-work-'));
  const a = s.add({ kind: 'claude-code', configDir: work });
  const b = s.add({ kind: 'claude-code' });
  s.select('chat', b.id);
  s.remove(b.id);
  assert.ok(!existsSync(b.configDir));
  assert.equal(s.selected('chat').id, 'system');
  s.remove(a.id);
  assert.ok(existsSync(work));
  assert.throws(() => s.remove('system'), /last connection/);
});

test('bad input is refused', () => {
  const s = new ConnectionStore({ home: home() });
  assert.throws(() => s.add({ kind: 'gpt-agent' }), /unknown connection kind/);
  assert.throws(() => s.add({ kind: 'claude-code', configDir: '/no/such/folder' }), /no folder/);
  assert.throws(() => s.update('system', { model: 'gpt-5' }), /unknown model/);
  assert.throws(() => s.select('chat', 'missing'), /no such connection/);
  assert.throws(() => s.select('boss', 'system'), /unknown role/);
});

test('a broken file falls back to the system login', () => {
  const h = home();
  mkdirSync(h, { recursive: true });
  const s = new ConnectionStore({ home: h });
  s.add({ kind: 'claude-code' });
  writeFileSync(path.join(h, 'connections.json'), '{not json');
  assert.deepEqual(new ConnectionStore({ home: h }).list().map((c) => c.id), ['system']);
});

test('the sign-in link is read from the OSC 8 hyperlink claude prints', () => {
  const out =
    'Opening browser to sign in…\nIf the browser didn\'t open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\x07https://claude.com/cai/oauth/authorize?code=true\x1b]8;;\x07\nPaste code here if prompted >';
  assert.equal(loginUrl(out), 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y');
  assert.equal(loginUrl('nothing here'), null);
});

test('API connections: a model is required, a server address where the kind needs one', () => {
  const s = new ConnectionStore({ home: home() });
  assert.throws(() => s.add({ kind: 'anthropic' }), /pick a model/);
  const a = s.add({ kind: 'anthropic', model: 'claude-opus-5-5' });
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.configDir, null);
  assert.throws(() => s.add({ kind: 'openai-compatible', model: 'x' }), /server address is missing/);
  assert.throws(() => s.add({ kind: 'openai-compatible', model: 'x', baseUrl: 'ftp://x' }), /http/);
  const c = s.add({ kind: 'openai-compatible', model: 'qwen/qwen3:32b', baseUrl: 'https://gw.example.com/v1/' });
  assert.equal(c.baseUrl, 'https://gw.example.com/v1');
  assert.equal(connectionBaseUrl(s.add({ kind: 'ollama', model: 'llama3.1:8b' })), 'http://127.0.0.1:11434/v1');
  assert.equal(connectionBaseUrl(s.add({ kind: 'openrouter', model: 'deepseek/deepseek-chat' })), 'https://openrouter.ai/api/v1');
  s.update(a.id, { model: 'claude-sonnet-5-5' });
  assert.throws(() => s.update(a.id, { model: 'has space' }), /unknown model/);
  assert.deepEqual(connectionEnv(a), {});
});
