import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function jwt() {
  return "aaa." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url") + ".sig";
}

function host(settings, { credentials, llm } = {}) {
  let route;
  let dispose;
  let record = { kind: "grant", payload: { type: "oauth", access: jwt(), refresh: "fake-refresh", accountId: "test-account", expires: 1 } };
  const ctx = {
    effect(callback) { dispose = callback(); },
    connection: { fetch: { register(value) { route = value; } } },
    credentials: credentials ?? {
      async readRecord() { return record; },
      async modifyRecord(_key, mutate) { record = await mutate(record); return record; },
    },
    get(name) {
      if (name === "settings") return settings;
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "openai-codex" }) };
    },
  };
  apply(ctx);
  const request = async () => {
    const response = await route.fetch(new Request("http://local/api/OAuth", { method: "POST", body: JSON.stringify({ action: "refresh", platform: "gpt" }) }));
    return { status: response.status, body: await response.json() };
  };
  request.dispose = () => dispose();
  return request;
}

function mockNetwork(t) {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/oauth/token")) return Response.json({ access_token: jwt(), refresh_token: "fake-new-refresh", expires_in: 3600 });
    if (String(url).includes("/codex/models")) return Response.json({ models: [] });
    throw new Error("unexpected network request");
  });
}

test("login refresh adds only the missing route through current settings API", async (t) => {
  mockNetwork(t);
  const edits = [];
  const settings = {
    describe() { return [{ ns: "llm-pi-ai", revision: 7, value: { providers: { xai: { models: [{ id: "custom" }] } } } }]; },
    async mutate(...args) { edits.push(args); },
  };
  const result = await host(settings)();
  assert.equal(result.status, 200);
  assert.deepEqual(edits, [["llm-pi-ai", [{ op: "set", path: ["providers", "openai-codex"], value: {} }], 7]]);
});

test("existing inherited model route is never overwritten", async (t) => {
  mockNetwork(t);
  const settings = {
    describe() { return [{ ns: "llm-pi-ai", revision: 3, value: { providers: { "openai-codex": { models: [{ id: "user-model" }] } } } }]; },
    async mutate() { assert.fail("must preserve existing route"); },
  };
  assert.equal((await host(settings)()).status, 200);
});

test("configuration failure is returned rather than reporting success", async (t) => {
  mockNetwork(t);
  const settings = {
    describe() { return [{ ns: "llm-pi-ai", revision: 0, value: { providers: {} } }]; },
    async mutate() { throw new Error("profile is read-only"); },
  };
  const result = await host(settings)();
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /profile is read-only/);
});

test("concurrent user route addition is preserved after revision conflict", async (t) => {
  mockNetwork(t);
  let changed = false;
  let writes = 0;
  const settings = {
    describe() { return [{ ns: "llm-pi-ai", revision: changed ? 2 : 1, value: { providers: changed ? { "openai-codex": { models: [{ id: "concurrent-user-model" }] } } : {} } }]; },
    async mutate() { writes++; changed = true; throw Object.assign(new Error("changed"), { code: "SETTINGS_CONFLICT" }); },
  };
  assert.equal((await host(settings)()).status, 200);
  assert.equal(writes, 1);
});

test("renamed settings entry is addressed using official provider metadata", async (t) => {
  mockNetwork(t);
  const edits = [];
  const settings = {
    describe() { return [{ ns: "custom-pi", revision: 4, value: { providers: {} } }]; },
    async mutate(...args) { edits.push(args); },
  };
  const llm = { listConfigurableProviders: () => [{ provider: "openai-codex", settingsNs: "custom-pi", settingsPath: ["providers", "openai-codex"] }] };
  assert.equal((await host(settings, { llm })()).status, 200);
  assert.deepEqual(edits, [["custom-pi", [{ op: "set", path: ["providers", "openai-codex"], value: {} }], 4]]);
});

test("refresh reads latest credential under the shared lock", async (t) => {
  let locked = false;
  let refreshed;
  const current = { kind: "grant", payload: { type: "oauth", access: jwt(), refresh: "newer-from-official-adapter", accountId: "test-account", expires: 1 } };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).includes("/oauth/token")) {
      assert.equal(locked, true);
      assert.equal(new URLSearchParams(init.body).get("refresh_token"), "newer-from-official-adapter");
      return Response.json({ access_token: jwt(), refresh_token: "rotated", expires_in: 3600 });
    }
    if (String(url).includes("/codex/models")) return Response.json({ models: [] });
    assert.fail("unexpected network request");
  });
  const credentials = {
    async readRecord() { return refreshed ?? current; },
    async modifyRecord(_key, mutate) { locked = true; try { refreshed = await mutate(current); return refreshed; } finally { locked = false; } },
  };
  const settings = { describe: () => [{ ns: "llm-pi-ai", revision: 0, value: { providers: { "openai-codex": {} } } }] };
  assert.equal((await host(settings, { credentials })()).status, 200);
  assert.equal(refreshed.payload.refresh, "rotated");
});

test("rotated token is retained when verification endpoint fails", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("/oauth/token")
    ? Response.json({ access_token: jwt(), refresh_token: "rotated", expires_in: 3600 })
    : new Response("unavailable", { status: 503 }));
  let saved;
  const credentials = {
    async modifyRecord(_key, mutate) {
      saved = await mutate({ kind: "grant", payload: { type: "oauth", access: jwt(), refresh: "old", accountId: "test-account", expires: 1 } });
      return saved;
    },
  };
  const result = await host({}, { credentials })();
  assert.equal(result.status, 502);
  assert.match(result.body.error, /凭据已更新/);
  assert.equal(saved.payload.refresh, "rotated");
});

test("unload after receiving a rotated token cannot discard its persistence", async (t) => {
  let saved;
  const credentials = {
    async modifyRecord(_key, mutate) {
      saved = await mutate({ kind: "grant", payload: { type: "oauth", access: jwt(), refresh: "old", accountId: "test-account", expires: 1 } });
      return saved;
    },
  };
  const h = host({}, { credentials });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /\/oauth\/token/);
    const response = Response.json({});
    response.json = async () => {
      h.dispose();
      return { access_token: jwt(), refresh_token: "rotated-before-unload", expires_in: 3600 };
    };
    return response;
  });
  assert.equal((await h()).status, 502);
  assert.equal(saved.payload.refresh, "rotated-before-unload");
});
