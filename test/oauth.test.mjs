import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, xaiRefresh, openaiRefresh, verifyGrant } from '../lib/oauth.js';
import { OPENAI_MODELS_URL, XAI_REFRESH_SKEW_MS } from '../lib/parse.js';
const NOW = 1_800_000_000_000;
const jwt = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`;
const xaiToken = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const openaiToken = { ...xaiToken, access_token: jwt };
const grant = { access: jwt, refresh: 'test-old-refresh', accountId: 'test-account' };
function reply(t, body, status = 200) { t.mock.method(globalThis, 'fetch', async () => ({ ok: status >= 200 && status < 300, status, async json() { return body; } })); }
for (const [refresh, base] of [[xaiRefresh, xaiToken], [openaiRefresh, openaiToken]]) {
  for (const field of ['access_token', 'refresh_token']) {
    test(refresh.name + ' refuses malformed ' + field, async t => {
      for (const value of ['', '  ', null, {}, 42, true]) { reply(t, { ...base, [field]: value }); await assert.rejects(refresh(grant)); }
    });
  }
  test(refresh.name + ' rejects invalid reported lifetime', async t => {
    for (const value of [null, 0, -1, Infinity, NaN, '3600', true, 1e308]) { reply(t, { ...base, expires_in: value }); await assert.rejects(refresh(grant)); }
  });
  test(refresh.name + ' rejects invalid previous token before network', async t => {
    let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(base); });
    await assert.rejects(refresh({ ...grant, refresh: '  ' })); assert.equal(calls, 0);
  });
}
test('xAI preserves omitted refresh token and official lifetime default', async t => {
  t.mock.method(Date, 'now', () => NOW); reply(t, { access_token: 'test-new-access' });
  assert.deepEqual(await xaiRefresh(grant), { type: 'oauth', access: 'test-new-access', refresh: grant.refresh, expires: NOW + 3_600_000 - XAI_REFRESH_SKEW_MS });
});
test('OpenAI rejects omitted refresh token and lifetime', async t => {
  for (const field of ['refresh_token', 'expires_in']) { const body = { ...openaiToken }; delete body[field]; reply(t, body); await assert.rejects(openaiRefresh(grant)); }
});
test('OpenAI refresh preserves accountId for opaque rotated access', async t => {
  t.mock.method(Date, 'now', () => NOW); reply(t, { ...openaiToken, access_token: 'test-opaque-rotated-access' });
  assert.deepEqual(await openaiRefresh(grant), { type: 'oauth', access: 'test-opaque-rotated-access', refresh: 'test-refresh', expires: NOW + 3_600_000, accountId: 'test-account' });
});
test('invalid JSON cannot validate grant', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>not JSON</html>', { status: 200 }));
  assert.equal((await requestJson(OPENAI_MODELS_URL)).ok, false); assert.equal(await verifyGrant({ id: 'openai-codex' }, grant), false);
});
test('OpenAI verification requires models catalog shape', async t => {
  for (const body of [{}, { ok: true }, { data: [] }, { models: null }, { models: [null] }, { models: [{}] }, { models: [{ slug: ' ' }] }]) { reply(t, body); assert.equal(await verifyGrant({ id: 'openai-codex' }, grant), false); }
  for (const body of [{ models: [] }, { models: [{ slug: 'test-model' }] }]) { reply(t, body); assert.equal(await verifyGrant({ id: 'openai-codex' }, grant), true); }
});
test('verification rejects malformed credentials without network', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ data: [], models: [] }); });
  for (const access of ['', ' ', {}, 42]) assert.equal(await verifyGrant({ id: 'xai' }, { ...grant, access }), false);
  assert.equal(await verifyGrant({ id: 'openai-codex' }, { ...grant, accountId: ' ' }), false); assert.equal(calls, 0);
});
test('xAI verification retains data catalog shape', async t => {
  reply(t, { data: [] }); assert.equal(await verifyGrant({ id: 'xai' }, grant), true);
  reply(t, { models: [] }); assert.equal(await verifyGrant({ id: 'xai' }, grant), false);
});
test('HTTP errors, network failures and cancellations cannot become success', async t => {
  reply(t, { models: [] }, 401); assert.equal(await verifyGrant({ id: 'openai-codex' }, grant), false);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture network failure'); });
  assert.equal((await requestJson(OPENAI_MODELS_URL)).ok, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(requestJson(OPENAI_MODELS_URL, { signal: controller.signal }));
});
