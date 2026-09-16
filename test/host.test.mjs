import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function jwtWith(payload) {
  return "aaa." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".sig";
}

function fakeCtx({ provider, records }) {
  let route;
  const ctx = {
    connection: {
      fetch: {
        register(options) {
          route = options;
        },
      },
    },
    credentials: {
      async readRecord(key) {
        return records[key];
      },
      async modifyRecord() {
        return undefined;
      },
      async deleteRecord() {
        return undefined;
      },
    },
    get(name) {
      if (name === "agentDefaultModel") {
        return { currentSelection: () => ({ provider }) };
      }
      return undefined;
    },
  };
  apply(ctx);
  return {
    async get(sessionId) {
      const response = await route.fetch(new Request(`http://local/api/OAuth?sessionId=${sessionId}`));
      return response.json();
    },
  };
}

const grokGrant = {
  kind: "grant",
  payload: { type: "oauth", access: "opaque-xai-token", refresh: "r", expires: Date.now() + 60_000 },
};

const gptGrant = {
  kind: "grant",
  payload: {
    type: "oauth",
    access: jwtWith({ "https://api.openai.com/profile": { email: "gpt@example.com" } }),
    refresh: "r",
    expires: Date.now() + 60_000,
    accountId: "11111111-2222-4333-8444-555555555555",
  },
};

test("grok model shows only the grok account", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("grok") || String(url).includes("x.ai")) {
      return new Response(JSON.stringify({ user: { email: "grok@example.com" } }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const host = fakeCtx({ provider: "xai", records: { "llm-pi-ai/xai": grokGrant } });
    const body = await host.get("s1");
    assert.equal(body.isSupported, true);
    assert.equal(body.platform, "grok");
    assert.equal(body.account.loggedIn, true);
    assert.equal(body.account.account, "grok@example.com");
    assert.equal("gpt" in body, false);
    assert.equal(JSON.stringify(body).includes("opaque-xai-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gpt model shows only the gpt account from the jwt", async () => {
  const host = fakeCtx({ provider: "openai-codex", records: { "llm-pi-ai/openai-codex": gptGrant } });
  const body = await host.get("s1");
  assert.equal(body.isSupported, true);
  assert.equal(body.platform, "gpt");
  assert.equal(body.account.account, "gpt@example.com");
  assert.equal("grok" in body, false);
});

test("other models hide the bar entirely", async () => {
  const host = fakeCtx({ provider: "deepseek-official", records: {} });
  const body = await host.get("s1");
  assert.equal(body.isSupported, false);
  assert.equal(body.platform, null);
  assert.equal(body.account, null);
});

test("grok identity failure still reports login without leaking the token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    const host = fakeCtx({ provider: "xai", records: { "llm-pi-ai/xai": grokGrant } });
    const body = await host.get("s1");
    assert.equal(body.platform, "grok");
    assert.equal(body.account.loggedIn, true);
    assert.equal(body.account.account, null);
    assert.equal(JSON.stringify(body).includes("opaque-xai-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
