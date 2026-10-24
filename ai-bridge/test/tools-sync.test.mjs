import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../tools.mjs';

// Browser tools are declared here and implemented in the frontend; a name
// that exists on one side only is a tool the model can call but never gets
// an answer for (or an implementation nobody can reach).
test('every browser tool has a frontend implementation and vice versa', () => {
  const src = readFileSync(fileURLToPath(new URL('../../frontend/src/ai/tools.ts', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('export const AI_TOOLS'));
  const implemented = [...body.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]).sort();
  const declared = TOOLS.filter((t) => t.where === 'browser').map((t) => t.name).sort();
  assert.deepEqual(implemented, declared);
});

test('tool names are unique', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});
