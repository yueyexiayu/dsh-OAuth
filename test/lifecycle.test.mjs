import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { OPENAI_DEVICE_USERCODE_URL, XAI_DEVICE_URL, XAI_TOKEN_URL } from "../lib/parse.js";

function host({ beforeWrite, authorization = { cancel() {} }, sessions } = {}) {
  let route;
  let dispose;
  const writes = [];
  apply({
    effect(callback) { dispose = callback(); },
    connection: { fetch: { register(value) { route = value; } } },
    credentials: {
      async readRecord() { return undefined; },
      async modifyRecord(key, mutate) { await beforeWrite?.(); const record = await mutate(undefined); writes.push({ key, record }); return record; },
      async deleteRecord() {},
    },
    get(name) {
      if (name === "authorization") return authorization;
      if (name === "agents" && sessions) {
        return { get(id) {
          const provider = sessions[id];
          if (!provider) return undefined;
          return { session: { requestHeader: () => ({ config: { provider } }) } };
        } };
      }
      if (name === "settings") return { describe: () => [{ ns: "llm-pi-ai", revision: 0, value: { providers: {} } }], async mutate() {} };
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "xai" }) };
    },
  });
  return {
    writes,
    dispose: () => dispose(),
    async call(action, platform = "grok", sessionId = "") {
      const payload = { action, sessionId };
      if (platform != null) payload.platform = platform;
      const response = await route.fetch(new Request(`http://local/api/OAuth?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        body: JSON.stringify(payload),
      }));
      return { status: response.status, body: await response.json() };
    },
    async status(sessionId = "") {
      return (await route.fetch(new Request(`http://local/api/OAuth?sessionId=${encodeURIComponent(sessionId)}`))).json();
    },
  };
}

const started = { device_code: "fake-device", user_code: "TEST", verification_uri: "https://example.invalid", interval: 1, expires_in: 900 };
const done = { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 };
const flush = () => new Promise(setImmediate);

for (const action of ["cancel", "logout", "dispose"]) {
  test(`${action} aborts in-flight login and ignores its late result`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let resolvePoll;
    let pollSignal;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (url === XAI_DEVICE_URL) return Response.json(started);
      assert.equal(url, XAI_TOKEN_URL);
      pollSignal = options.signal;
      return await new Promise((resolve) => { resolvePoll = resolve; });
    });
    const h = host();
    assert.equal((await h.call("start")).status, 200);
    t.mock.timers.tick(1000);
    await flush();
    assert.ok(resolvePoll);
    if (action === "dispose") h.dispose();
    else await h.call(action);
    assert.equal(pollSignal.aborted, true);
    resolvePoll(Response.json(done));
    await flush();
    assert.deepEqual(h.writes, []);
    if (action !== "dispose") assert.equal((await h.status()).pending, null);
    else assert.equal((await h.call("start")).status, 503);
    h.dispose();
  });
}

test("successful device login persists grant and clears pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (url) => url === XAI_DEVICE_URL ? Response.json(started) : Response.json(done));
  const h = host();
  await h.call("start");
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, "llm-pi-ai/xai");
  assert.equal((await h.status()).pending, null);
  h.dispose();
});

test("failed device-code request remains visible in status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("failed", { status: 503 }));
  const h = host();
  assert.equal((await h.call("start")).status, 502);
  assert.match((await h.status()).pending.error, /申请设备码失败/);
  h.dispose();
});

test("starting gpt login does not cancel an in-flight grok login or write into the gpt record", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolvePoll;
  let grokSignal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === XAI_DEVICE_URL) return Response.json({ ...started, user_code: "GROK-CODE" });
    if (url === OPENAI_DEVICE_USERCODE_URL) return Response.json({ device_auth_id: "fake-gpt-device", user_code: "GPT-TEST", interval: 5 });
    assert.equal(url, XAI_TOKEN_URL);
    grokSignal = options.signal;
    return await new Promise((resolve) => { resolvePoll = resolve; });
  });
  const h = host({ sessions: { "session-a": "xai", "session-b": "openai-codex", "session-c": "deepseek-official" } });
  try {
    await h.call("start", "grok", "session-a");
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(grokSignal.aborted, false);
    await h.call("start", "gpt", "session-b");
    assert.equal(grokSignal.aborted, false);
    assert.equal((await h.status("session-a")).pending.userCode, "GROK-CODE");
    assert.equal((await h.status("session-b")).pending.userCode, "GPT-TEST");
    resolvePoll(Response.json(done));
    await flush();
    assert.deepEqual(h.writes.map((item) => item.key), ["llm-pi-ai/xai"]);
    assert.equal((await h.status("session-b")).pending.userCode, "GPT-TEST");
    assert.equal((await h.status("session-a")).pending, null);
  } finally { h.dispose(); }
});

test("another session cannot see a device code or inherit its platform", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, XAI_DEVICE_URL);
    return Response.json({ ...started, user_code: "SESSION-A-CODE", verification_uri: "https://example.invalid/session-a" });
  });
  const h = host({ sessions: { "session-a": "xai", "session-b": "xai", "session-c": "deepseek-official" } });
  try {
    const startedBody = await h.call("start", "grok", "session-a");
    assert.equal(startedBody.body.pending.userCode, "SESSION-A-CODE");
    const owner = await h.status("session-a");
    assert.equal(owner.platform, "grok");
    assert.equal(owner.pending.userCode, "SESSION-A-CODE");
    assert.equal(owner.pending.verificationUri, "https://example.invalid/session-a");
    const peer = await h.status("session-b");
    assert.equal(peer.platform, "grok");
    assert.equal(peer.pending, null);
    assert.equal(JSON.stringify(peer).includes("SESSION-A-CODE"), false);
    assert.equal(JSON.stringify(peer).includes("example.invalid"), false);
    const other = await h.status("session-c");
    assert.equal(other.isSupported, false);
    assert.equal(other.platform, null);
    assert.equal(other.pending, null);
    assert.equal(JSON.stringify(other).includes("SESSION-A-CODE"), false);
  } finally { h.dispose(); }
});

test("cancel without a platform only cancels logins started by that session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === XAI_DEVICE_URL) return Response.json({ ...started, user_code: "GROK-CODE" });
    if (url === OPENAI_DEVICE_USERCODE_URL) return Response.json({ device_auth_id: "fake-gpt-device", user_code: "GPT-TEST", interval: 5 });
    throw new Error("unexpected " + url);
  });
  const h = host({ sessions: { "session-a": "xai", "session-b": "openai-codex" } });
  try {
    await h.call("start", "grok", "session-a");
    await h.call("start", "gpt", "session-b");
    const response = await h.call("cancel", null, "session-a");
    assert.equal(response.body.pending, null);
    assert.equal((await h.status("session-b")).pending.userCode, "GPT-TEST");
  } finally { h.dispose(); }
});

test("logout and switching accounts cancel the official authorization for the same key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(started));
  const cancelled = [];
  const h = host({ authorization: { cancel(key) { cancelled.push(key); } } });
  try {
    await h.call("logout", "gpt");
    await h.call("start", "grok");
    assert.deepEqual(cancelled, ["llm-pi-ai/openai-codex", "llm-pi-ai/xai"]);
  } finally { h.dispose(); }
});

for (const stalled of [false, true]) {
  test(`device deadline stops ${stalled ? "an in-flight" : "pending"} poll and preserves expiry error`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
    let polls = 0;
    let signal;
    let release;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (url === XAI_DEVICE_URL) return Response.json({ ...started, expires_in: 3 });
      polls++;
      signal = options.signal;
      if (stalled) return await new Promise((resolve) => { release = resolve; });
      return Response.json({ error: "authorization_pending" }, { status: 400 });
    });
    const h = host();
    try {
      await h.call("start");
      t.mock.timers.tick(1000);
      await flush();
      t.mock.timers.tick(2000);
      await flush();
      assert.match((await h.status()).pending.error, /设备码已过期/);
      if (stalled) {
        assert.equal(signal.aborted, true);
        release(Response.json(done));
        await flush();
      }
      const stoppedAt = polls;
      t.mock.timers.tick(20 * 60 * 1000);
      await flush();
      assert.equal(polls, stoppedAt);
      assert.deepEqual(h.writes, []);
    } finally { h.dispose(); }
  });
}

test("cancel while waiting for credential lock prevents a late write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let unlock;
  t.mock.method(globalThis, "fetch", async (url) => url === XAI_DEVICE_URL ? Response.json(started) : Response.json(done));
  const h = host({ beforeWrite: () => new Promise((resolve) => { unlock = resolve; }) });
  await h.call("start");
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(unlock);
  await h.call("cancel");
  unlock();
  await flush();
  assert.deepEqual(h.writes, []);
  assert.equal((await h.status()).pending, null);
  h.dispose();
});

test("device deadline while waiting for credential lock rejects an accepted token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let unlock;
  t.mock.method(globalThis, "fetch", async (url) => url === XAI_DEVICE_URL
    ? Response.json({ ...started, expires_in: 3 }) : Response.json(done));
  const h = host({ beforeWrite: () => new Promise((resolve) => { unlock = resolve; }) });
  try {
    await h.call("start");
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(typeof unlock, "function");
    t.mock.timers.tick(2000);
    await flush();
    assert.match((await h.status()).pending.error, /设备码已过期/);
    unlock();
    await flush();
    assert.deepEqual(h.writes, []);
    assert.match((await h.status()).pending.error, /设备码已过期/);
  } finally { unlock?.(); h.dispose(); }
});
