import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function host(t, { model = { next: { provider: 'openai-codex', model: 'gpt-test' }, lastUsed: { provider: 'xai', model: 'grok-test' } }, error, begin, read } = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network blocked by fixture'); });
  let route, dispose, released = 0;
  const calls = [];
  const ctx = {
    effect(fn) { dispose = fn(); }, on() { return () => {}; },
    connection: { fetch: { register(r) { route = r; } } },
    credentials: { async readRecord(key) { calls.push(['read', key]); return read?.(key); }, async deleteRecord(key) { calls.push(['delete', key]); }, async modifyRecord() { assert.fail('not expected'); } },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'xai', model: 'global-grok' }) };
      if (name === 'sessionQuery') return { async observeSession(id) { calls.push(['observe', id]); if (error) throw error; return { source: 'persisted', header: { id }, projections: { values: { modelSelection: model } }, [Symbol.dispose]() { released++; } }; } };
      if (name === 'authorization') return { describe: () => ({ methods: [{ id: 'oauth' }], inFlight: false }), cancel() {}, begin: begin ?? (() => { throw new Error('synthetic begin failure'); }) };
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { xai: {}, 'openai-codex': {} } } }] };
    },
  };
  apply(ctx); t.after(() => dispose());
  return { calls, get released() { return released; }, async call(action, platform, sessionId = 'history', extra = {}) {
    const response = await route.fetch(new Request('http://fixture.invalid/api/OAuth?sessionId=' + sessionId, action ? { method: 'POST', body: JSON.stringify({ action, platform, sessionId, ...extra }) } : {}));
    return { status: response.status, body: await response.json() };
  } };
}

test('cold history uses next before lastUsed and releases observation', async t => {
  const h = host(t); const r = await h.call();
  assert.equal(r.status, 200); assert.equal(r.body.platform, 'gpt'); assert.equal(h.released, h.calls.filter(c => c[0] === 'observe').length);
  assert.deepEqual(h.calls.filter(c => c[0] === 'read'), [['read', 'llm-pi-ai/openai-codex']]);
});
test('known empty session may use default selection', async t => {
  const h = host(t, { model: { next: null, lastUsed: null } });
  assert.equal((await h.call()).body.platform, 'grok'); assert.equal(h.released, h.calls.filter(c => c[0] === 'observe').length);
});
for (const code of ['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_PERSISTENCE_FAILED', 'SESSION_QUERY_CORRUPT_SESSION']) {
  test('session error ' + code + ' cannot use unrelated global account', async t => {
    const h = host(t, { error: Object.assign(new Error('synthetic session failure'), { code }) });
    const r = await h.call(); assert.notEqual(r.status, 200); assert.equal(r.body.ok, false); assert.equal(h.calls.some(c => c[0] === 'read'), false);
  });
}
for (const action of ['start', 'logout', 'refresh', 'cancel']) {
  test(action + ' cannot target account inconsistent with current next', async t => {
    const h = host(t); const r = await h.call(action, 'grok');
    assert.equal(r.status, 409); assert.equal(h.calls.some(c => ['read', 'delete'].includes(c[0])), false);
  });
}
test('login formally uses authorization.begin and explicitly chooses device flow', async t => {
  let request;
  const h = host(t, { begin: async r => { request = r;
    assert.equal(await r.interaction.prompt({ kind: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] }), 'device_code');
    r.interaction.notify({ message: 'Enter code', url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' });
    return await new Promise(() => {});
  } });
  const r = await h.call('start', 'gpt');
  assert.equal(r.status, 200); assert.equal(request.key, 'llm-pi-ai/openai-codex'); assert.equal(request.method, 'oauth'); assert.equal(r.body.pending.userCode, 'TEST-CODE');
});
test('late account lookup cannot return old provider after selection changes', async t => {
  const model = { next: { provider: 'openai-codex', model: 'gpt-test' }, lastUsed: null };
  let release; const h = host(t, { model, read: () => new Promise(r => { release = r; }) });
  const pending = h.call(); await new Promise(setImmediate);
  model.next = { provider: 'deepseek', model: 'other' }; release(undefined);
  const r = await pending; assert.equal(r.status, 409); assert.equal(r.body.ok, false);
});
for (const sessionId of [0, null, false, {}, [], '', '   ']) {
  test('explicit invalid sessionId is not a global-account request: ' + JSON.stringify(sessionId), async t => {
    const h = host(t); const r = await h.call('logout', 'gpt', 'history', { sessionId });
    assert.equal(r.status, 400); assert.equal(h.calls.length, 0);
  });
}
for (const next of [{}, { provider: '' }, { provider: 42 }]) {
  test('invalid next does not fall back to lastUsed: ' + JSON.stringify(next), async t => {
    const h = host(t, { model: { next, lastUsed: { provider: 'xai', model: 'old' } } });
    const r = await h.call(); assert.equal(r.status, 502); assert.equal(h.calls.some(c => c[0] === 'read'), false); assert.equal(h.released, 1);
  });
}
test('history without pending next uses its own lastUsed', async t => {
  const h = host(t, { model: { next: null, lastUsed: { provider: 'openai-codex', model: 'history-gpt' } } });
  assert.equal((await h.call()).body.platform, 'gpt');
});
test('missing model projection refuses access instead of global fallback', async t => {
  const absent = host(t, { model: null });
  assert.equal((await absent.call()).status, 502); assert.equal(absent.calls.some(c => c[0] === 'read'), false);
});
