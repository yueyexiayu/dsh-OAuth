import test from "node:test";
import assert from "node:assert/strict";
import {
  requestJson, xaiStart, xaiPollOnce, xaiRefresh,
  openaiStart, openaiPollOnce, openaiRefresh, verifyGrant,
} from "../lib/oauth.js";
import { OPENAI_TOKEN_URL, OPENAI_MODELS_URL, XAI_REFRESH_SKEW_MS } from "../lib/parse.js";

const NOW = 1_800_000_000_000;
const jwt = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
const xaiDevice = { device_code: "test-device", user_code: "TEST", verification_uri: "https://example.invalid/verify", interval: 5, expires_in: 900 };
const openaiDevice = { device_auth_id: "test-device", user_code: "TEST", interval: "5" };
const xaiToken = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 };
const openaiToken = { access_token: jwt, refresh_token: "test-refresh", expires_in: 3600 };
const grant = { access: jwt, refresh: "test-old-refresh", accountId: "test-account" };

function reply(t, body, status = 200) {
  t.mock.method(globalThis, "fetch", async () => ({ ok: status >= 200 && status < 300, status, async json() { return body; } }));
}
function clock(t) { t.mock.method(Date, "now", () => NOW); }

// Sources for independent expectations: installed pi-ai OAuth device timeout (15 * 60),
// and openai/codex protocol/src/openai_models.rs (ModelsResponse.models, ModelInfo.slug).
test("device starts expose finite absolute deadlines", async (t) => {
  clock(t);
  reply(t, xaiDevice);
  assert.equal((await xaiStart()).expiresAt, NOW + 900_000);
  reply(t, openaiDevice);
  assert.equal((await openaiStart()).expiresAt, NOW + 900_000);
  reply(t, { ...openaiDevice, expires_in: 60 });
  assert.equal((await openaiStart()).expiresAt, NOW + 60_000);
});

for (const value of [undefined, null, 0, -1, Infinity, NaN, "900", true, 1e308]) {
  test(`xAI rejects invalid device lifetime ${String(value)}`, async (t) => {
    reply(t, { ...xaiDevice, expires_in: value });
    await assert.rejects(xaiStart());
  });
}
for (const value of [null, 0, -1, Infinity, "900", 1e308]) {
  test(`OpenAI rejects invalid explicit device lifetime ${String(value)}`, async (t) => {
    reply(t, { ...openaiDevice, expires_in: value });
    await assert.rejects(openaiStart());
  });
}

for (const uri of ["http://example.invalid", "javascript:alert(1)", "https://user:pass@example.invalid", "https://user@example.invalid", "not-a-url"]) {
  test(`xAI rejects unsafe verification URI ${uri}`, async (t) => {
    reply(t, { ...xaiDevice, verification_uri: uri });
    await assert.rejects(xaiStart());
    reply(t, { ...xaiDevice, verification_uri_complete: uri });
    await assert.rejects(xaiStart());
  });
}
test("xAI uses safe complete URI and finite default polling interval", async (t) => {
  reply(t, { ...xaiDevice, interval: Infinity, verification_uri_complete: "https://example.invalid/complete" });
  const started = await xaiStart();
  assert.equal(started.interval, 5);
  assert.equal(started.verificationUri, "https://example.invalid/complete");
});

for (const [start, base, fields] of [[xaiStart, xaiDevice, ["device_code", "user_code"]], [openaiStart, openaiDevice, ["device_auth_id", "user_code"]]]) {
  for (const field of fields) {
    test(`${start.name} rejects empty and non-string ${field}`, async (t) => {
      for (const value of ["", "  ", {}, 42]) {
        reply(t, { ...base, [field]: value });
        await assert.rejects(start());
      }
    });
  }
}

for (const field of ["authorization_code", "code_verifier"]) {
  test(`OpenAI rejects invalid PKCE ${field} without token exchange`, async (t) => {
    for (const value of ["", "  ", {}, 42]) {
      let calls = 0;
      t.mock.method(globalThis, "fetch", async (url) => {
        calls++;
        if (url === OPENAI_TOKEN_URL) return Response.json(openaiToken);
        return Response.json({ authorization_code: "test-code", code_verifier: "test-verifier", [field]: value });
      });
      await assert.rejects(openaiPollOnce("test-device", "TEST"));
      assert.equal(calls, 1);
    }
  });
}

test("OpenAI exchanges valid code and derives account from JWT", async (t) => {
  clock(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === OPENAI_TOKEN_URL) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("code_verifier"), "test-verifier");
      assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
      return Response.json(openaiToken);
    }
    return Response.json({ authorization_code: "test-code", code_verifier: "test-verifier" });
  });
  assert.deepEqual(await openaiPollOnce("test-device", "TEST"), {
    done: true, payload: { type: "oauth", access: jwt, refresh: "test-refresh", expires: NOW + 3_600_000, accountId: "test-account" },
  });
});

for (const [refresh, base] of [[xaiRefresh, xaiToken], [openaiRefresh, openaiToken]]) {
  for (const field of ["access_token", "refresh_token"]) {
    test(`${refresh.name} rejects malformed ${field} instead of a saveable payload`, async (t) => {
      for (const value of ["", "  ", null, {}, 42, true]) {
        reply(t, { ...base, [field]: value });
        await assert.rejects(refresh(grant));
      }
    });
  }
  test(`${refresh.name} rejects invalid reported lifetime`, async (t) => {
    for (const value of [null, 0, -1, Infinity, NaN, "3600", true, 1e308]) {
      reply(t, { ...base, expires_in: value });
      await assert.rejects(refresh(grant));
    }
  });
  test(`${refresh.name} rejects invalid previous refresh token before network`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(base); });
    await assert.rejects(refresh({ ...grant, refresh: "  " }));
    assert.equal(calls, 0);
  });
}

test("xAI preserves omitted refresh token and official omitted lifetime default", async (t) => {
  clock(t);
  reply(t, { access_token: "test-new-access" });
  assert.deepEqual(await xaiRefresh(grant), { type: "oauth", access: "test-new-access", refresh: grant.refresh, expires: NOW + 3_600_000 - XAI_REFRESH_SKEW_MS });
  reply(t, { access_token: "test-access", refresh_token: "test-refresh" });
  assert.equal((await xaiPollOnce("test-device")).payload.expires, NOW + 3_600_000 - XAI_REFRESH_SKEW_MS);
});
test("OpenAI rejects omitted refresh token and lifetime on refresh", async (t) => {
  for (const field of ["refresh_token", "expires_in"]) {
    const body = { ...openaiToken }; delete body[field];
    reply(t, body);
    await assert.rejects(openaiRefresh(grant));
  }
});
test("xAI successful polling requires valid token strings and expiry", async (t) => {
  for (const patch of [{ access_token: {} }, { refresh_token: " " }, { expires_in: Infinity }]) {
    reply(t, { ...xaiToken, ...patch });
    await assert.rejects(xaiPollOnce("test-device"));
  }
});

for (const status of [403, 404]) {
  for (const code of ["expired_token", "deviceauth_expired", "access_denied", "authorization_denied", "invalid_grant"]) {
    test(`OpenAI terminal ${code} takes priority over HTTP ${status}`, async (t) => {
      for (const error of [code, { code }]) {
        reply(t, { error }, status);
        await assert.rejects(openaiPollOnce("test-device", "TEST"));
      }
    });
  }
}
test("OpenAI retains legacy HTTP pending and explicit pending/slow_down behavior", async (t) => {
  for (const [status, body, slowDown] of [[403, {}, false], [404, {}, false], [400, { error: { code: "deviceauth_authorization_pending" } }, false], [403, { error: "slow_down" }, true]]) {
    reply(t, body, status);
    assert.deepEqual(await openaiPollOnce("test-device", "TEST"), { done: false, slowDown });
  }
});

test("invalid JSON is explicitly unsuccessful and cannot validate OpenAI grant", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>not JSON</html>", { status: 200 }));
  const response = await requestJson(OPENAI_MODELS_URL);
  assert.equal(response.ok, false);
  assert.equal(response.status, 200);
  assert.equal(await verifyGrant({ id: "openai-codex" }, grant), false);
});
test("OpenAI verification requires real models catalog shape, not arbitrary JSON", async (t) => {
  for (const body of [{}, { ok: true }, { data: [] }, { models: null }, { models: [null] }, { models: [{}] }, { models: [{ slug: " " }] }]) {
    reply(t, body);
    assert.equal(await verifyGrant({ id: "openai-codex" }, grant), false);
  }
  for (const body of [{ models: [] }, { models: [{ slug: "test-model", display_name: "Test model" }] }]) {
    reply(t, body);
    assert.equal(await verifyGrant({ id: "openai-codex" }, grant), true);
  }
});
test("verification rejects malformed access/account without network", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ models: [], data: [] }); });
  for (const access of ["", " ", {}, 42]) assert.equal(await verifyGrant({ id: "xai" }, { ...grant, access }), false);
  assert.equal(await verifyGrant({ id: "openai-codex" }, { ...grant, accountId: " " }), false);
  assert.equal(calls, 0);
});
test("OpenAI code exchange rejects malformed token responses", async (t) => {
  for (const patch of [{ access_token: {} }, { refresh_token: " " }, { expires_in: null }, { expires_in: Infinity }, { access_token: "opaque-without-account" }]) {
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url === OPENAI_TOKEN_URL) return Response.json({ ...openaiToken, ...patch });
      return Response.json({ authorization_code: "test-code", code_verifier: "test-verifier" });
    });
    await assert.rejects(openaiPollOnce("test-device", "TEST"));
  }
});
test("OpenAI refresh preserves existing accountId for valid opaque rotated access", async (t) => {
  clock(t);
  reply(t, { ...openaiToken, access_token: "test-opaque-rotated-access" });
  assert.deepEqual(await openaiRefresh(grant), {
    type: "oauth", access: "test-opaque-rotated-access", refresh: "test-refresh", expires: NOW + 3_600_000, accountId: "test-account",
  });
});
test("xAI pending, slow-down and terminal responses stay explicit", async (t) => {
  reply(t, { error: "authorization_pending" }, 400);
  assert.deepEqual(await xaiPollOnce("test-device"), { done: false, slowDown: false });
  reply(t, { error: "slow_down" }, 400);
  assert.deepEqual(await xaiPollOnce("test-device"), { done: false, slowDown: true });
  for (const error of ["expired_token", "access_denied", "authorization_denied"]) {
    reply(t, { error }, 400);
    await assert.rejects(xaiPollOnce("test-device"));
  }
});
test("xAI model verification retains data catalog and rejects JSON parsing failures", async (t) => {
  reply(t, { data: [] });
  assert.equal(await verifyGrant({ id: "xai" }, grant), true);
  reply(t, { models: [] });
  assert.equal(await verifyGrant({ id: "xai" }, grant), false);
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON", { status: 200 }));
  assert.equal(await verifyGrant({ id: "xai" }, grant), false);
});
test("HTTP errors, network failures and cancellations cannot become success", async (t) => {
  reply(t, { models: [] }, 401);
  assert.equal(await verifyGrant({ id: "openai-codex" }, grant), false);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("test network failure"); });
  assert.equal((await requestJson(OPENAI_MODELS_URL)).ok, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestJson(OPENAI_MODELS_URL, { signal: controller.signal }));
});
