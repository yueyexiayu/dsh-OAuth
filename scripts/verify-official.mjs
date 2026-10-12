// Optional component integration: synthetic data only, no network or disk store.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

const base = process.env.DSH_OFFICIAL_NODE_MODULES;
if (!base || !isAbsolute(base)) {
  throw new Error("DSH_OFFICIAL_NODE_MODULES must name an absolute, unpacked official node_modules directory");
}
const require = createRequire(join(base, "@deepseek-ai/dsh-authorization/lib/index.js"));
const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")));
const { CredentialProvider } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-credentials")));
const { AuthorizationService } = await import(pathToFileURL(join(base, "@deepseek-ai/dsh-authorization/lib/index.js")));
const { createModels } = await import(pathToFileURL(join(base, "@earendil-works/pi-ai/dist/models.js")));
const { apply: applyOfficialPiAi } = await import(pathToFileURL(join(base, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js')));
const KEY = "llm-pi-ai/openai-codex";
const record = { kind: "grant", payload: {
  type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", accountId: "synthetic-account", expires: 1,
} };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
class MemoryCredentials extends CredentialProvider {
  records = new Map();
  operations = Promise.resolve();
  log = [];
  block = null;
  enqueue(fn) {
    const result = this.operations.then(fn);
    // Match credentials-local's settled FIFO tail; the returned error remains visible.
    this.operations = result.catch(() => {});
    return result;
  }
  async readRecord(key) { return this.records.get(key); }
  async describeRecord(key) { return { configured: this.records.has(key), writable: true }; }
  modifyRecord(key, fn) {
    this.log.push("queue-write");
    return this.enqueue(async () => {
      if (this.block) await this.block;
      const next = await fn(this.records.get(key));
      this.records.set(key, next);
      this.log.push("write");
      this.ctx.emit("credentials/record-updated", key);
      return next;
    });
  }
  deleteRecord(key) {
    this.log.push("queue-delete");
    return this.enqueue(async () => {
      this.records.delete(key);
      this.log.push("delete");
      this.ctx.emit("credentials/record-updated", key);
    });
  }
}
async function host(t, provider = 'openai-codex', fixtureFetch) {
  t.mock.method(globalThis, 'fetch', fixtureFetch ?? (async (url) => {
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/revoke', 'unexpected network blocked');
    return new Response(null, { status: 200 });
  }));
  const ctx = new Context();
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(AuthorizationService);
  let route;
  let dispose;
  let selectedProvider = provider;
  t.after(() => {
    dispose();
    ctx.registry.delete(AuthorizationService);
    ctx.registry.delete(MemoryCredentials);
  });
  apply({
    credentials: ctx.credentials,
    on: (...args) => ctx.on(...args),
    effect(callback) { dispose = callback(); },
    connection: { fetch: { register(value) { route = value; } } },
    get(name) {
      if (name === "authorization") return ctx.authorization;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: selectedProvider }) };
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { [provider]: {} } } }] };
    },
  });
  return { ctx, select(provider) { selectedProvider = provider; }, async call(action) {
    const response = await route.fetch(new Request('http://fixture.invalid/api/OAuth', action ? { method: 'POST', body: JSON.stringify({ action, platform: provider === 'xai' ? 'grok' : 'gpt' }) } : {}));
    return { status: response.status, body: await response.json() };
  }, async logout(beforeBody) {
    const body = JSON.stringify({ action: "logout", platform: "gpt" });
    const request = new Request("http://local/api/OAuth", { method: "POST", body });
    // Control body-read completion to expose an accepted result before its await continuation.
    if (beforeBody) request.text = () => { beforeBody(); return Promise.resolve(body); };
    const response = await route.fetch(request);
    assert.equal(response.status, 200);
    return response.json();
  } };
}
function installOfficialFlows(ctx) {
  applyOfficialPiAi({
    fiber: {}, logger: ctx.logger,
    inject(services, callback) { if (services.includes('authorization')) callback({ authorization: ctx.authorization, logger: ctx.logger }); },
    get(name) { if (name === 'credentials') return ctx.credentials; },
    on() {},
    llm: { registerConfigurableProviders() { return { replace() {} }; }, registerModelDiscovery() {} },
  }, { providers: { get: () => ({}) } });
}
for (const provider of ['xai', 'openai-codex']) {
  test('actual official pi-ai flow supplies device code through plugin begin: ' + provider, async t => {
    const endpoints = [];
    const h = await host(t, provider, async (url, options) => {
      endpoints.push(String(url));
      if (String(url) === 'https://auth.x.ai/oauth2/device/code') return Response.json({ device_code: 'SYNTHETIC-device', user_code: 'TEST-XAI', verification_uri: 'https://accounts.x.ai/device', interval: 5, expires_in: 900 });
      if (String(url) === 'https://auth.openai.com/api/accounts/deviceauth/usercode') return Response.json({ device_auth_id: 'SYNTHETIC-device', user_code: 'TEST-GPT', interval: '5' });
      // Codex begins a poll immediately; hold it until cancellation.
      if (String(url) === 'https://auth.openai.com/api/accounts/deviceauth/token') return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      assert.fail('unexpected fixture request ' + url);
    });
    installOfficialFlows(h.ctx);
    const started = await h.call('start');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.pending.userCode, provider === 'xai' ? 'TEST-XAI' : 'TEST-GPT');
    assert.equal(started.body.pending.platform, provider === 'xai' ? 'grok' : 'gpt');
    assert.equal(h.ctx.authorization.describe('llm-pi-ai/' + provider).inFlight, true);
    assert.deepEqual(h.ctx.credentials.log, []);
    const cancelled = await h.call('cancel'); assert.equal(cancelled.status, 200); assert.equal(cancelled.body.pending, null);
    await new Promise(setImmediate);
    assert.equal(h.ctx.authorization.describe('llm-pi-ai/' + provider).inFlight, false);
    assert.deepEqual(h.ctx.credentials.log, []);
    assert.ok(endpoints.length >= 1);
  });
}
function begin(ctx, run) {
  ctx.authorization.registerFlow({ key: KEY, label: "synthetic", methods: [{ id: "oauth", label: "synthetic" }], run });
  return ctx.authorization.begin({ key: KEY, interaction: { notify() {}, prompt: async () => "" } });
}
test("official authorization: logout cancels delayed commit", async (t) => {
  const { ctx, logout } = await host(t);
  const gate = deferred();
  let lateError;
  const attempt = begin(ctx, async (session) => {
    await gate.promise;
    try { await session.commit(record); } catch (error) { lateError = error; throw error; }
  });
  await logout();
  assert.equal((await attempt).status, "cancelled");
  gate.resolve();
  await new Promise(setImmediate);
  assert.ok(lateError);
  assert.equal(await ctx.credentials.readRecord(KEY), undefined);
});
test("official authorization: deletion wins over a commit already in progress", async (t) => {
  const { ctx, logout } = await host(t);
  const gate = deferred();
  ctx.credentials.block = gate.promise;
  const attempt = begin(ctx, (session) => session.commit(record));
  const pendingLogout = logout();
  await Promise.resolve();
  gate.resolve();
  await pendingLogout;
  assert.equal((await attempt).status, "authorized");
  assert.equal(await ctx.credentials.readRecord(KEY), undefined);
  assert.equal(ctx.credentials.log.at(-1), "delete");
});
test('official authorization: logout revokes the latest grant accepted before settlement', async t => {
  const revoked = [];
  const { ctx, logout } = await host(t, 'openai-codex', async (url, options) => {
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/revoke');
    revoked.push(new URLSearchParams(options.body).get('token'));
    return new Response(null, { status: 200 });
  });
  const latest = { kind: 'grant', payload: { ...record.payload, access: 'synthetic-new-access', refresh: 'synthetic-new-refresh' } };
  ctx.credentials.records.set(KEY, record);
  const gate = deferred(), cancellation = deferred();
  ctx.credentials.block = gate.promise;
  const originalCancel = ctx.authorization.cancel.bind(ctx.authorization);
  t.mock.method(ctx.authorization, 'cancel', key => { originalCancel(key); cancellation.resolve(); });
  const attempt = begin(ctx, session => session.commit(latest));
  const pendingLogout = logout();
  await cancellation.promise;
  assert.deepEqual(revoked, [], 'must wait for the accepted commit before revocation');
  gate.resolve();
  await pendingLogout;
  assert.equal((await attempt).status, 'authorized');
  assert.deepEqual(revoked, ['synthetic-new-refresh']);
  assert.equal(await ctx.credentials.readRecord(KEY), undefined);
  assert.equal(ctx.credentials.log.at(-1), 'delete');
});
test('official authorization: provider change during settlement prevents revoke and deletion', async t => {
  const h = await host(t, 'openai-codex', async () => { assert.fail('selection changed; no revocation is allowed'); });
  const gate = deferred(), cancellation = deferred();
  h.ctx.credentials.block = gate.promise;
  const originalCancel = h.ctx.authorization.cancel.bind(h.ctx.authorization);
  t.mock.method(h.ctx.authorization, 'cancel', key => { originalCancel(key); cancellation.resolve(); });
  const attempt = begin(h.ctx, session => session.commit(record));
  const pendingLogout = h.call('logout');
  await cancellation.promise;
  h.select('xai'); gate.resolve();
  const result = await pendingLogout;
  assert.equal(result.status, 409);
  assert.equal((await attempt).status, 'authorized');
  assert.deepEqual(await h.ctx.credentials.readRecord(KEY), record);
  assert.equal(h.ctx.credentials.log.includes('delete'), false);
});
test("official pi-ai: accepted-login microtask cannot restore a logged-out account", async (t) => {
  const { ctx, logout } = await host(t);
  const gate = deferred();
  // Installed llm-pi-ai adapter's modify contract does not forward the third signal option.
  const models = createModels({ credentials: {
    modify: (_id, fn) => ctx.credentials.modifyRecord(KEY, async (current) => ({
      kind: "grant", payload: await fn(current?.payload),
    })).then((r) => r.payload),
  } });
  models.setProvider({ id: "openai-codex", name: "synthetic", auth: { oauth: { login: () => gate.promise } } });
  const attempt = begin(ctx, (session) => models.login("openai-codex", "oauth", { signal: session.signal }));
  const result = await logout(() => gate.resolve(record.payload));
  // Cancellation now precedes the credential read, so the service reports
  // cancelled even though pi-ai's already-accepted queued write still completes.
  assert.equal((await attempt).status, "cancelled");
  await new Promise(setImmediate);
  assert.ok(ctx.credentials.log.includes('write'), 'exercise the accepted queued write, not a skipped login');
  assert.equal(result.account.loggedIn, false);
  assert.equal(await ctx.credentials.readRecord(KEY), undefined);
  assert.equal(ctx.credentials.log.at(-1), "delete");
});
