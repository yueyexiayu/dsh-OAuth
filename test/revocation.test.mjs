import test from 'node:test';
import assert from 'node:assert/strict';
import { revokeGrant } from '../lib/oauth.js';

for (const [code, expected] of [['invalid_token', true], ['unsupported_token_type', false]]) {
  test(`revocation ${code} preserves the actual remote outcome`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: code }, { status: 400 }));
    const result = await revokeGrant('xai', { access: 'synthetic-access', refresh: 'synthetic-refresh' }, new AbortController().signal);
    assert.equal(result.ok, expected);
    if (!expected) assert.match(result.message, /HTTP 400.*本地凭据已删除/);
  });
}
