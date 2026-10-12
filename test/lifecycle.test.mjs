import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function host(t, run) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture blocks unexpected network'); });
  let route, dispose, modelListener;
  const attempts = []; const listeners = new Set();
  const authorization = {
    describe: () => ({ methods: [{ id: 'oauth' }], inFlight: attempts.some(a => !a.done) }),
    cancel() { for (const a of attempts) if (!a.done) a.signalDispatch(); },
    async begin(request) {
      let cancel;
      const aborted = new Promise(resolve => { cancel = () => resolve({ status: 'cancelled' }); });
      request.signal.addEventListener('abort', cancel, { once: true });
      const attempt = { request, done: false, signalDispatch: cancel }; attempts.push(attempt);
      try { return await Promise.race([run(request, attempts.length), aborted]); }
      finally { attempt.done = true; request.signal.removeEventListener('abort', cancel); for (const listener of listeners) listener(request.key); }
    },
  };
  apply({
    effect(fn) { dispose = fn(); }, on(event, fn) { if (event === 'session/event') { modelListener = fn; return () => { modelListener = undefined; }; } listeners.add(fn); return () => listeners.delete(fn); },
    connection: { fetch: { register(r) { route = r; } } },
    credentials: { async readRecord() {}, async deleteRecord() {}, async modifyRecord() { assert.fail('plugin must not commit login'); } },
    get(name) {
      if (name === 'authorization') return authorization;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'openai-codex', model: 'fixture-gpt' }) };
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'openai-codex': {} } } }] };
    },
  });
  t.after(() => dispose());
  return { attempts, dispose, event(event) { modelListener?.({ id: '' }, event); }, switchProvider(provider) { modelListener?.({ id: '' }, { type: 'model/selection', data: { provider, model: 'changed' } }); }, async call(action) {
    const response = await route.fetch(new Request('http://fixture.invalid/api/OAuth', action ? { method: 'POST', body: JSON.stringify({ action, platform: 'gpt' }) } : {}));
    return { status: response.status, body: await response.json() };
  } };
}
const notice = { message: 'fixture', url: 'https://auth.openai.com/codex/device', code: 'TEST' };
const flush = () => new Promise(setImmediate);
test('switching session provider stops the previous official device flow', async t => {
  const h = host(t, async r => { r.interaction.notify(notice); return await new Promise(() => {}); });
  await h.call('start'); h.switchProvider('deepseek');
  assert.equal(h.attempts[0].request.signal.aborted, true);
  assert.equal((await h.call()).body.pending, null);
});
test('late last-used request header cannot cancel next-provider authorization', async t => {
  const h = host(t, async r => { r.interaction.notify(notice); return await new Promise(() => {}); });
  await h.call('start'); h.event({ type: 'request/header', data: { header: { config: { provider: 'xai' } } } });
  assert.equal(h.attempts[0].request.signal.aborted, false);
  assert.equal((await h.call()).body.pending.userCode, 'TEST');
});
for (const action of ['cancel', 'logout', 'dispose']) {
  test(action + ' aborts official flow and ignores late notices', async t => {
    let request;
    const h = host(t, async r => { request = r; r.interaction.notify(notice); return await new Promise(() => {}); });
    assert.equal((await h.call('start')).status, 200);
    if (action === 'dispose') h.dispose(); else assert.equal((await h.call(action)).status, 200);
    assert.equal(request.signal.aborted, true);
    request.interaction.notify({ ...notice, code: 'LATE' });
    if (action !== 'dispose') assert.equal((await h.call()).body.pending, null);
    else assert.equal((await h.call('start')).status, 503);
  });
}
test('official completion clears pending without duplicate plugin write', async t => {
  let resolve;
  const h = host(t, r => { r.interaction.notify(notice); return new Promise(done => { resolve = done; }); });
  await h.call('start'); resolve({ status: 'authorized' }); await flush();
  assert.equal((await h.call()).body.pending, null);
});
test('official flow failure before notice is visible and never returns success', async t => {
  const h = host(t, async () => { throw new Error('synthetic opaque private value'); });
  const result = await h.call('start'); assert.equal(result.status, 502);
  assert.match(result.body.error, /官方 OAuth/); assert.doesNotMatch(result.body.error, /opaque private/);
  assert.match((await h.call()).body.pending.error, /失败/);
});
test('official flow failure after code keeps terminal error visible', async t => {
  let reject;
  const h = host(t, r => { r.interaction.notify(notice); return new Promise((_resolve, fail) => { reject = fail; }); });
  await h.call('start'); reject(new Error('device expired')); await flush();
  assert.match((await h.call()).body.pending.error, /失败/);
});
test('switching accounts aborts prior official flow before starting replacement', async t => {
  const h = host(t, async r => { r.interaction.notify(notice); return await new Promise(() => {}); });
  await h.call('start'); await h.call('start');
  assert.equal(h.attempts.length, 2); assert.equal(h.attempts[0].request.signal.aborted, true);
  assert.equal(h.attempts[1].request.signal.aborted, false);
});
for (const url of ['http://auth.openai.com/device', 'https://auth.openai.com.evil.invalid/device', 'https://user@auth.openai.com/device', 'https://auth.openai.com:8443/device']) {
  test('untrusted official notice is refused: ' + url, async t => {
    const h = host(t, async r => { r.interaction.notify({ ...notice, url }); return { status: 'cancelled' }; });
    const result = await h.call('start'); assert.equal(result.status, 502); assert.match(result.body.error, /不受信任/);
  });
}
test('device_code secret is removed from public authorization URL', async t => {
  const h = host(t, async r => { r.interaction.notify({ ...notice, url: notice.url + '?user_code=TEST&device_code=private#private' }); return await new Promise(() => {}); });
  const result = await h.call('start'); assert.doesNotMatch(JSON.stringify(result.body), /private|device_code/);
});
test('unrecognized official prompt fails instead of silently choosing browser login', async t => {
  const h = host(t, async r => { await r.interaction.prompt({ kind: 'text', message: 'enter code' }); });
  const result = await h.call('start'); assert.equal(result.status, 502); assert.match(result.body.error, /失败/);
});
