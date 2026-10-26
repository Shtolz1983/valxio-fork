import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeRunsTypeScript } from '../nodeVersion.mjs';

test('the bridge needs a Node that runs TypeScript itself', () => {
  for (const v of ['20.19.5', '22.17.1', '23.5.0']) assert.equal(nodeRunsTypeScript(v), false, v);
  for (const v of ['22.18.0', '23.6.0', '24.19.0', '25.0.0']) assert.equal(nodeRunsTypeScript(v), true, v);
});
