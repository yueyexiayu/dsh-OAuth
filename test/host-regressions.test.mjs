import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import {
  GROK_USER_URL,
  OPENAI_DEVICE_USERCODE_URL,
  XAI_DEVICE_URL,
  XAI_MODELS_URL,
  XAI_REVOKE_URL,
  XAI_TOKEN_URL,
  XAI_USERINFO_URL,
} from "../lib/parse.js";

// Synthetic credentials and endpoint fixtures only. Unexpected requests fail;
// no installed service, real settings, credential document, or login is used.
const XAI_KEY = "llm-pi-ai/xai";
const CODEX_KEY = "llm-pi-ai/openai-codex";
const OLD_ACCESS = "SYNTHETIC-opaque-old-access-H48";
const OLD_REFRESH = "SYNTHETIC-opaque-old-refresh-F32";
const NEW_ACCESS = "SYNTHETIC-opaque-new-access-A93";
const NEW_REFRESH = "SYNTHETIC-opaque-new-refresh-R81";
const initialGrant = () => ({
  kind: "grant",
  payload: { type: "oauth", access: OLD_ACCESS, refresh: OLD_REFRESH, expires: Date.now() + 60_000 },
});
const tokenResponse = { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 };
const deviceResponse = {
  device_code: "SYNTHETIC-device-code",
  user_code: "TEST",
  verification_uri: "https://auth.x.ai/device",
  interval: 1,
  expires_in: 900,
};
const flush = () => new Promise(setImmediate);

function fixtureFetch(t, handler = () => assert.fail("unexpected fixture request")) {
  t.mock.method(globalThis, "fetch", async (url, options) => handler(url, options));
}

function credentialStore({ initial, persist } = {}) {
  const records = new Map(initial ? [[XAI_KEY, initial]] : []);
  const queued = [];
  const committed = [];
  let operations = Promise.resolve();
  function enqueue(operation) {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  }
  return {
    records, queued, committed,
    async readRecord(key) { return records.get(key); },
    modifyRecord(key, mutate) {
      queued.push(["modify", key]);
      return enqueue(async () => {
        const current = records.get(key);
        const next = await mutate(current);
        await persist?.(next, current);
        if (next !== undefined) {
          records.set(key, next);
          committed.push(["modify", key]);
        }
        return next ?? current;
      });
    },
    deleteRecord(key) {
      queued.push(["delete", key]);
      return enqueue(async () => {
        records.delete(key);
        committed.push(["delete", key]);
      });
    },
  };
}

function createHost(t, { credentials = credentialStore(), authorization, settings, llm } = {}) {
  let route;
  let cleanup;
  const listeners = new Set();
  let unsubscriptions = 0;
  const ctx = {
    effect(callback) { cleanup = callback(); },
    on(event, listener) {
      assert.equal(event, "authorization/settled");
      listeners.add(listener);
      let active = true;
      return () => {
        if (active) { active = false; listeners.delete(listener); unsubscriptions++; }
      };
    },
    connection: { fetch: { register(value) { route = value; } } },
    credentials,
    get(name) {
      if (name === "authorization") return authorization ?? { cancel() {} };
      if (name === "settings") return settings ?? {
        describe: () => [{ ns: "llm-pi-ai", revision: 0, value: { providers: { xai: {} } } }],
        async mutate() { assert.fail("existing route must not be changed"); },
      };
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "xai" }) };
    },
  };
  apply(ctx);
  const h = {
    credentials,
    get listenerCount() { return listeners.size; },
    get unsubscriptions() { return unsubscriptions; },
    emit(key, settlement = "cancelled") { for (const listener of [...listeners]) listener(key, settlement); },
    dispose() { cleanup(); },
    async call(action, platform = "grok") {
      const response = await route.fetch(new Request("http://fixture.invalid/api/OAuth", {
        method: "POST", body: JSON.stringify({ action, platform }),
      }));
      return { status: response.status, body: await response.json() };
    },
    async status() {
      const response = await route.fetch(new Request("http://fixture.invalid/api/OAuth"));
      assert.equal(response.status, 200);
      return response.json();
    },
  };
  t.after(() => h.dispose());
  return h;
}

function assertNoSecrets(value, secrets = [OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]) {
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, "public result contains synthetic credential");
}

test("device login redacts opaque new tokens in post-mutation persistence errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fixtureFetch(t, (url) => {
    if (url === XAI_DEVICE_URL) return Response.json(deviceResponse);
    assert.equal(url, XAI_TOKEN_URL);
    return Response.json(tokenResponse);
  });
  let mutationReturned = false;
  const credentials = credentialStore({ persist(next) {
    assert.equal(next.payload.access, NEW_ACCESS);
    assert.equal(next.payload.refresh, NEW_REFRESH);
    mutationReturned = true;
    throw new Error(`backend save failed for ${next.payload.access} / ${next.payload.refresh}`);
  } });
  const h = createHost(t, { credentials });
  assert.equal((await h.call("start")).status, 200);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(mutationReturned, true);
  const status = await h.status();
  assert.match(status.pending.error, /backend save failed/);
  assertNoSecrets(status);
  assert.equal(status.account.loggedIn, false);
  assert.equal(credentials.records.size, 0);
  assert.deepEqual(credentials.committed, []);
});

test("refresh redacts old and new opaque tokens when persistence fails after mutation", async (t) => {
  fixtureFetch(t, (url, options) => {
    assert.equal(url, XAI_TOKEN_URL);
    assert.equal(new URLSearchParams(options.body).get("refresh_token"), OLD_REFRESH);
    return Response.json(tokenResponse);
  });
  const original = initialGrant();
  let mutationReturned = false;
  const credentials = credentialStore({ initial: original, persist(next, current) {
    assert.equal(next.payload.access, NEW_ACCESS);
    assert.equal(next.payload.refresh, NEW_REFRESH);
    mutationReturned = true;
    throw new Error(`backend save failed: ${current.payload.access} / ${current.payload.refresh} / ${next.payload.access} / ${next.payload.refresh}`);
  } });
  const h = createHost(t, { credentials });
  const result = await h.call("refresh");
  assert.equal(mutationReturned, true);
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /backend save failed/);
  assertNoSecrets(result.body);
  assert.deepEqual(credentials.records.get(XAI_KEY), original);
  assert.deepEqual(credentials.committed, []);
});

test("malformed xAI refresh is an error and cannot replace the existing grant", async (t) => {
  fixtureFetch(t, (url) => {
    assert.equal(url, XAI_TOKEN_URL);
    return Response.json({ ...tokenResponse, access_token: "" });
  });
  const original = initialGrant();
  const credentials = credentialStore({ initial: original });
  const h = createHost(t, { credentials });
  const result = await h.call("refresh");
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /access_token/);
  assertNoSecrets(result.body);
  assert.deepEqual(credentials.records.get(XAI_KEY), original);
  assert.deepEqual(credentials.committed, []);
});

for (const [label, profile, expected] of [
  ["omitted apiKeyEnv", { models: [{ id: "synthetic-custom-model" }] }, "oauth"],
  ["named apiKeyEnv", { apiKeyEnv: "SYNTHETIC_ROUTE_KEY", models: [{ id: "synthetic-custom-model" }] }, "api-key"],
  ["explicit undefined apiKeyEnv", { apiKeyEnv: undefined, models: [{ id: "synthetic-custom-model" }] }, "oauth"],
]) {
  test(`custom provider settings preserve ${label} through refresh and logout`, async (t) => {
    fixtureFetch(t, (url) => {
      if (url === XAI_TOKEN_URL) return Response.json(tokenResponse);
      if (url === XAI_MODELS_URL) return Response.json({ data: [] });
      if (url === XAI_REVOKE_URL) return new Response(null, { status: 200 });
      assert.ok(url === GROK_USER_URL || url === XAI_USERINFO_URL, "unexpected fixture request");
      return Response.json({ email: "synthetic@example.invalid" });
    });
    const value = { custom: { grokRoute: structuredClone(profile) } };
    const snapshot = structuredClone(value);
    const settings = {
      describe(options) {
        assert.deepEqual(options, { redactSecrets: true });
        return [{ ns: "synthetic-custom-provider", revision: 7, value }];
      },
      async mutate() { assert.fail("preexisting provider profile must be preserved"); },
    };
    const llm = { listConfigurableProviders: () => [{
      provider: "xai", settingsNs: "synthetic-custom-provider", settingsPath: ["custom", "grokRoute"],
    }] };
    const h = createHost(t, { credentials: credentialStore({ initial: initialGrant() }), settings, llm });
    assert.equal((await h.status()).authMode, expected);
    const refreshed = await h.call("refresh");
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.authMode, expected);
    assert.equal(refreshed.body.account.loggedIn, true);
    assert.equal(refreshed.body.account.account, "synthetic@example.invalid");
    assertNoSecrets(refreshed.body, ["SYNTHETIC_ROUTE_KEY", OLD_ACCESS, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH]);
    assert.deepEqual(value, snapshot);
    const loggedOut = await h.call("logout");
    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.body.authMode, expected);
    assert.equal(loggedOut.body.account.loggedIn, false);
    assertNoSecrets(loggedOut.body, ["SYNTHETIC_ROUTE_KEY"]);
    assert.deepEqual(value, snapshot);
  });
}

test("logout waits only for its official key, then deletes after the accepted queued write", async (t) => {
  fixtureFetch(t);
  const cancellations = [];
  const authorization = {
    describe(key) { assert.equal(key, XAI_KEY); return { inFlight: true }; },
    cancel(key) { cancellations.push(key); },
  };
  const h = createHost(t, { authorization });
  let completed = false;
  const logout = h.call("logout").then((result) => { completed = true; return result; });
  await flush();
  assert.deepEqual(cancellations, [XAI_KEY]);
  assert.equal(h.listenerCount, 1);
  assert.equal(completed, false);
  assert.deepEqual(h.credentials.queued, []);
  h.emit(CODEX_KEY);
  await flush();
  assert.equal(completed, false);
  assert.equal(h.listenerCount, 1);
  assert.deepEqual(h.credentials.queued, []);
  // Portable simulation of an official result accepted before cancellation,
  // whose continuation queues its shared-store write before settlement.
  const officialWrite = Promise.resolve().then(() => h.credentials.modifyRecord(XAI_KEY, async () => initialGrant()));
  queueMicrotask(() => h.emit(XAI_KEY));
  const result = await logout;
  await officialWrite;
  assert.equal(result.status, 200);
  assert.equal(result.body.account.loggedIn, false);
  assert.deepEqual(h.credentials.queued, [["modify", XAI_KEY], ["delete", XAI_KEY]]);
  assert.deepEqual(h.credentials.committed, [["modify", XAI_KEY], ["delete", XAI_KEY]]);
  assert.equal(h.credentials.records.has(XAI_KEY), false);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
});

test("logout aborts the local poll before waiting for official settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolvePoll;
  let pollSignal;
  let inFlight = false;
  fixtureFetch(t, (url, options) => {
    if (url === XAI_DEVICE_URL) return Response.json(deviceResponse);
    assert.equal(url, XAI_TOKEN_URL);
    pollSignal = options.signal;
    return new Promise((resolve) => { resolvePoll = resolve; });
  });
  const authorization = {
    describe() { return { inFlight }; },
    cancel(key) { if (inFlight) assert.equal(key, XAI_KEY); },
  };
  const h = createHost(t, { authorization });
  assert.equal((await h.call("start")).status, 200);
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(resolvePoll);
  assert.equal(pollSignal.aborted, false);
  inFlight = true;
  const operation = h.call("logout", "grok");
  await flush();
  assert.equal(pollSignal.aborted, true);
  assert.equal(h.listenerCount, 1);
  assert.deepEqual(h.credentials.queued, []);
  assert.equal((await h.status()).pending, null);
  resolvePoll(Response.json(tokenResponse));
  await flush();
  assert.deepEqual(h.credentials.committed, []);
  inFlight = false;
  h.emit(XAI_KEY);
  const result = await operation;
  assert.equal(result.status, 200);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
  assert.equal(result.body.pending, null);
  assert.deepEqual(h.credentials.committed, [["delete", XAI_KEY]]);
});

test("starting gpt waits for its own official settlement without aborting grok", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolvePoll;
  let pollSignal;
  let codexStarts = 0;
  let inFlight = false;
  fixtureFetch(t, (url, options) => {
    if (url === XAI_DEVICE_URL) return Response.json(deviceResponse);
    if (url === OPENAI_DEVICE_USERCODE_URL) {
      codexStarts++;
      return Response.json({ device_auth_id: "SYNTHETIC-codex-device", user_code: "TEST-GPT", interval: 5 });
    }
    assert.equal(url, XAI_TOKEN_URL);
    pollSignal = options.signal;
    return new Promise((resolve) => { resolvePoll = resolve; });
  });
  const authorization = {
    describe() { return { inFlight }; },
    cancel(key) { if (inFlight) assert.equal(key, CODEX_KEY); },
  };
  const h = createHost(t, { authorization });
  assert.equal((await h.call("start")).status, 200);
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(resolvePoll);
  inFlight = true;
  const operation = h.call("start", "gpt");
  await flush();
  assert.equal(pollSignal.aborted, false);
  assert.equal(h.listenerCount, 1);
  assert.equal(codexStarts, 0);
  const waiting = await h.status();
  assert.equal(waiting.platform, "grok");
  assert.equal(waiting.pending.userCode, "TEST");
  assert.equal(JSON.stringify(waiting).includes("TEST-GPT"), false);
  inFlight = false;
  h.emit(CODEX_KEY);
  const result = await operation;
  assert.equal(result.status, 200);
  assert.equal(codexStarts, 1);
  assert.equal(pollSignal.aborted, false);
  assert.equal(result.body.platform, "grok");
  assert.equal(result.body.pending.userCode, "TEST");
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
  assert.deepEqual(h.credentials.committed, []);
  resolvePoll(Response.json({ error: "authorization_pending" }, { status: 400 }));
  await flush();
});

test("dispose rejects an official settlement wait and removes its listener without deleting", async (t) => {
  fixtureFetch(t);
  const h = createHost(t, { authorization: { describe: () => ({ inFlight: true }), cancel() {} } });
  const operation = h.call("logout");
  await flush();
  assert.equal(h.listenerCount, 1);
  h.dispose();
  const result = await operation;
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.ok(result.body.error);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
  h.emit(XAI_KEY);
  await flush();
  assert.deepEqual(h.credentials.queued, []);
  assert.equal((await h.call("logout")).status, 503);
});

test("dispose after official settlement resolves still prevents a new deletion", async (t) => {
  fixtureFetch(t);
  const original = initialGrant();
  const h = createHost(t, {
    credentials: credentialStore({ initial: original }),
    authorization: { describe: () => ({ inFlight: true }), cancel() {} },
  });
  const operation = h.call("logout");
  await flush();
  assert.equal(h.listenerCount, 1);
  // Resolve the barrier, then unload before the awaiting continuation runs.
  h.emit(XAI_KEY);
  h.dispose();
  const result = await operation;
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.ok(result.body.error);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
  assert.deepEqual(h.credentials.queued, []);
  assert.deepEqual(h.credentials.records.get(XAI_KEY), original);
});

test("official cancellation errors remove the preinstalled listener and do not delete", async (t) => {
  fixtureFetch(t);
  const h = createHost(t, { authorization: {
    describe: () => ({ inFlight: true }),
    cancel() { throw new Error("synthetic cancellation failure"); },
  } });
  const result = await h.call("logout");
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /synthetic cancellation failure/);
  assert.equal(h.listenerCount, 0);
  assert.equal(h.unsubscriptions, 1);
  assert.deepEqual(h.credentials.queued, []);
});

test("logout delete failure redacts the grant read before deletion", async (t) => {
  fixtureFetch(t, (url) => {
    assert.equal(url, XAI_REVOKE_URL);
    return new Response(null, { status: 200 });
  });
  const original = initialGrant();
  const credentials = {
    async readRecord() { return original; },
    async deleteRecord() { throw new Error(`delete failed ${OLD_ACCESS} ${OLD_REFRESH}`); },
    async modifyRecord() { throw new Error("not used"); },
  };
  const h = createHost(t, { credentials });
  const result = await h.call("logout");
  assert.equal(result.status, 502);
  assert.match(result.body.error, /delete failed/);
  assert.match(result.body.error, /<redacted>/);
  assertNoSecrets(result.body);
});

test("logout revokes the refresh token, still deletes when revocation fails, and does not edit routes", async (t) => {
  const bodies = [];
  fixtureFetch(t, async (url, options) => {
    assert.equal(url, XAI_REVOKE_URL);
    bodies.push(String(options.body));
    return Response.json({ error: "server_error", error_description: OLD_REFRESH }, { status: 500 });
  });
  const settings = {
    describe() { return []; },
    async mutate() { assert.fail("logout must not edit model routes"); },
  };
  const credentials = credentialStore({ initial: initialGrant() });
  const h = createHost(t, { credentials, settings });
  const result = await h.call("logout");
  assert.equal(result.status, 502);
  assert.match(result.body.error, /本地凭据已删除/);
  assert.equal(result.body.error.includes(OLD_REFRESH), false);
  assert.equal(result.body.error.includes(OLD_ACCESS), false);
  assert.equal(credentials.records.has(XAI_KEY), false);
  assert.match(bodies[0], /token_type_hint=refresh_token/);
  assert.match(bodies[0], /client_id=/);
  assert.equal(bodies[0].includes("grant_type"), false);
});
