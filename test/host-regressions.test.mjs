import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { GROK_USER_URL, XAI_MODELS_URL, XAI_REVOKE_URL, XAI_TOKEN_URL, XAI_USERINFO_URL } from '../lib/parse.js';
const KEY = 'llm-pi-ai/xai';
const OLD = { kind: 'grant', payload: { type: 'oauth', access: 'SYNTHETIC-old-access', refresh: 'SYNTHETIC-old-refresh', expires: 1 } };
const TOKEN = { access_token: 'SYNTHETIC-new-access', refresh_token: 'SYNTHETIC-new-refresh', expires_in: 3600 };
const flush = () => new Promise(setImmediate);
function store(initial, persist) {
  const records = new Map(initial ? [[KEY, initial]] : []), operations = [];
  let tail = Promise.resolve();
  const enqueue = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  return { records, operations, async readRecord(key) { return records.get(key); },
    modifyRecord(key, fn) { operations.push(['modify', key]); return enqueue(async () => { const next = await fn(records.get(key)); await persist?.(next); records.set(key, next); return next; }); },
    deleteRecord(key) { operations.push(['delete', key]); return enqueue(() => { records.delete(key); }); },
  };
}
function host(t, { credentials = store(), authorization = { cancel() {} }, settings, llm, fetch = () => assert.fail('unexpected fixture network') } = {}) {
  t.mock.method(globalThis, 'fetch', fetch);
  let route, dispose; const listeners = new Set();
  apply({ effect(fn) { dispose = fn(); }, on(event, fn) { if (event !== 'authorization/settled') return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    connection: { fetch: { register(r) { route = r; } } }, credentials,
    get(name) {
      if (name === 'authorization') return authorization;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'xai', model: 'fixture-grok' }) };
      if (name === 'llm') return llm;
      if (name === 'settings') return settings ?? { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { xai: {} } } }], mutate() { assert.fail('route must be preserved'); } };
    },
  });
  t.after(() => dispose());
  return { credentials, dispose, listeners, emit(key) { for (const fn of [...listeners]) fn(key); }, async call(action) {
    const r = await route.fetch(new Request('http://fixture.invalid/api/OAuth', { method: 'POST', body: JSON.stringify({ action, platform: 'grok' }) }));
    return { status: r.status, body: await r.json() };
  } };
}
function noSecrets(body) { for (const secret of [OLD.payload.access, OLD.payload.refresh, TOKEN.access_token, TOKEN.refresh_token]) assert.equal(JSON.stringify(body).includes(secret), false); }
function normalFetch(url) {
  if (url === XAI_TOKEN_URL) return Response.json(TOKEN);
  if (url === XAI_MODELS_URL) return Response.json({ data: [] });
  if (url === XAI_REVOKE_URL) return new Response(null, { status: 200 });
  if (url === GROK_USER_URL || url === XAI_USERINFO_URL) return Response.json({ email: 'synthetic@example.invalid' });
  assert.fail('unexpected endpoint');
}
test('refresh persistence failure redacts old and new opaque credentials', async t => {
  const credentials = store(OLD, next => { throw new Error(`save failed ${OLD.payload.access} ${OLD.payload.refresh} ${next.payload.access} ${next.payload.refresh}`); });
  const h = host(t, { credentials, fetch: normalFetch }); const r = await h.call('refresh');
  assert.equal(r.status, 502); assert.match(r.body.error, /save failed/); noSecrets(r.body); assert.deepEqual(credentials.records.get(KEY), OLD);
});
test('malformed refresh cannot replace previous grant', async t => {
  const h = host(t, { credentials: store(OLD), fetch: () => Response.json({ ...TOKEN, access_token: '' }) });
  const r = await h.call('refresh'); assert.equal(r.status, 502); assert.deepEqual(h.credentials.records.get(KEY), OLD); noSecrets(r.body);
});
for (const [profile, expected] of [[{ models: [{ id: 'custom' }] }, 'oauth'], [{ apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'custom' }] }, 'api-key'], [{ apiKeyEnv: undefined }, 'oauth']]) {
  test('refresh/logout preserve custom routes and auth mode ' + expected + JSON.stringify(profile), async t => {
    const value = { custom: { route: profile } }, snapshot = structuredClone(value);
    const settings = { describe: () => [{ ns: 'custom-pi', value }], mutate() { assert.fail('must not mutate route'); } };
    const llm = { listConfigurableProviders: () => [{ provider: 'xai', settingsNs: 'custom-pi', settingsPath: ['custom', 'route'] }] };
    const h = host(t, { credentials: store(OLD), settings, llm, fetch: normalFetch });
    const refreshed = await h.call('refresh'); assert.equal(refreshed.status, 200); assert.equal(refreshed.body.authMode, expected); noSecrets(refreshed.body);
    const loggedOut = await h.call('logout'); assert.equal(loggedOut.status, 200); assert.equal(loggedOut.body.authMode, expected); assert.equal(loggedOut.body.account.loggedIn, false); assert.deepEqual(value, snapshot);
  });
}
test('logout waits only for same-key official settlement and deletes after accepted queued write', async t => {
  const cancelled = [];
  const h = host(t, { authorization: { describe: () => ({ inFlight: true }), cancel(key) { cancelled.push(key); } } });
  let complete = false; const request = h.call('logout').then(r => { complete = true; return r; }); await flush();
  assert.deepEqual(cancelled, [KEY]); assert.equal(h.listeners.size, 1); h.emit('llm-pi-ai/openai-codex'); await flush(); assert.equal(complete, false);
  const write = h.credentials.modifyRecord(KEY, async () => OLD); h.emit(KEY); const r = await request; await write;
  assert.equal(r.status, 200); assert.equal(h.credentials.records.has(KEY), false); assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.credentials.operations, [['modify', KEY], ['delete', KEY]]);
});
for (const afterSettlement of [false, true]) {
  test('dispose ' + (afterSettlement ? 'after' : 'during') + ' settlement wait prevents deletion', async t => {
    const h = host(t, { authorization: { describe: () => ({ inFlight: true }), cancel() {} } });
    const request = h.call('logout'); await flush(); assert.equal(h.listeners.size, 1);
    if (afterSettlement) h.emit(KEY); h.dispose(); const r = await request;
    assert.equal(r.status, 502); assert.equal(h.listeners.size, 0); assert.deepEqual(h.credentials.operations, []);
  });
}
test('official cancellation failure releases listener and does not delete', async t => {
  const h = host(t, { authorization: { describe: () => ({ inFlight: true }), cancel() { throw new Error('synthetic cancel failure'); } } });
  const r = await h.call('logout'); assert.equal(r.status, 502); assert.match(r.body.error, /cancel failure/); assert.equal(h.listeners.size, 0); assert.deepEqual(h.credentials.operations, []);
});
test('delete failure redacts credentials known before deletion', async t => {
  const credentials = store(OLD); credentials.deleteRecord = async () => { throw new Error(`delete failed ${OLD.payload.access} ${OLD.payload.refresh}`); };
  const r = await host(t, { credentials, fetch: normalFetch }).call('logout'); assert.equal(r.status, 502); assert.match(r.body.error, /delete failed/); noSecrets(r.body);
});
test('remote revocation failure still deletes local credential and leaves routes untouched', async t => {
  let form;
  const h = host(t, { credentials: store(OLD), fetch(url, options) { assert.equal(url, XAI_REVOKE_URL); form = new URLSearchParams(options.body); return Response.json({ error: 'server_error' }, { status: 500 }); } });
  const r = await h.call('logout'); assert.equal(r.status, 502); assert.match(r.body.error, /本地凭据已删除/); noSecrets(r.body); assert.equal(h.credentials.records.has(KEY), false);
  assert.equal(form.get('token'), OLD.payload.refresh); assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.has('grant_type'), false);
});
