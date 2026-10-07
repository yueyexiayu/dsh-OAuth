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
async function host(t) {
  const ctx = new Context();
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(AuthorizationService);
  let route;
  let dispose;
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
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "openai-codex" }) };
    },
  });
  return { ctx, async logout(beforeBody) {
    const body = JSON.stringify({ action: "logout", platform: "gpt" });
    const request = new Request("http://local/api/OAuth", { method: "POST", body });
    // Control body-read completion to expose an accepted result before its await continuation.
    if (beforeBody) request.text = () => { beforeBody(); return Promise.resolve(body); };
    const response = await route.fetch(request);
    assert.equal(response.status, 200);
    return response.json();
  } };
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
  assert.equal((await attempt).status, "cancelled");
  await new Promise(setImmediate);
  assert.equal(result.account.loggedIn, false);
  assert.equal(await ctx.credentials.readRecord(KEY), undefined);
  assert.equal(ctx.credentials.log.at(-1), "delete");
});
