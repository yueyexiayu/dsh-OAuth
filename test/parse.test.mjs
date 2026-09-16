import test from "node:test";
import assert from "node:assert/strict";
import {
  accountIdFromJwt,
  displayNameFromIdentity,
  displayNameFromJwt,
  grantFromRecord,
  looksLikeOpaqueId,
  pickDisplayName,
  platformOf,
  publicAccount,
  safeDetail,
} from "../lib/parse.js";

function jwtWith(payload) {
  return "aaa." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".sig";
}

test("platform aliases", () => {
  assert.equal(platformOf("grok").id, "xai");
  assert.equal(platformOf("gpt").id, "openai-codex");
  assert.equal(platformOf("nope"), null);
});

test("displayNameFromIdentity finds nested emails", () => {
  assert.equal(displayNameFromIdentity({ user: { email: "user@example.com" } }), "user@example.com");
  assert.equal(displayNameFromIdentity({ data: { profile: { mail: "user@example.com" } } }), "user@example.com");
  assert.equal(displayNameFromIdentity({ name: "Example" }), "Example");
  assert.equal(displayNameFromIdentity({ userId: "11111111-2222-4333-8444-555555555555" }), null);
});

test("publicAccount falls back to a jwt email for xai-style tokens", () => {
  const grant = {
    access: jwtWith({ email: "grok@example.com" }),
    refresh: "secret-refresh-token-value",
    expires: Date.now() + 60_000,
  };
  const pub = publicAccount(grant);
  assert.equal(pub.account, "grok@example.com");
  assert.equal(JSON.stringify(pub).includes("secret-refresh"), false);
});

test("opaque ids are not treated as accounts", () => {
  assert.equal(looksLikeOpaqueId("11111111-2222-4333-8444-555555555555"), true);
  assert.equal(looksLikeOpaqueId("user@example.com"), false);
  assert.equal(pickDisplayName("11111111-2222-4333-8444-555555555555", "user@example.com"), "user@example.com");
});

test("accountIdFromJwt reads chatgpt_account_id only", () => {
  const token = jwtWith({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_only" } });
  assert.equal(accountIdFromJwt(token), "acct_test_only");
});

test("displayNameFromJwt prefers profile email over account id", () => {
  const token = jwtWith({
    "https://api.openai.com/auth": { chatgpt_account_id: "11111111-2222-4333-8444-555555555555" },
    "https://api.openai.com/profile": { email: "user@example.com", name: "Example" },
  });
  assert.equal(displayNameFromJwt(token), "user@example.com");
});

test("publicAccount hides tokens and opaque ids", () => {
  const grant = {
    access: jwtWith({
      "https://api.openai.com/profile": { email: "user@example.com" },
    }),
    refresh: "secret-refresh-token-value",
    accountId: "11111111-2222-4333-8444-555555555555",
    expires: Date.now() + 60_000,
  };
  const pub = publicAccount(grant);
  const text = JSON.stringify(pub);
  assert.equal(pub.loggedIn, true);
  assert.equal(pub.account, "user@example.com");
  assert.equal(text.includes("secret-refresh"), false);
  assert.equal(text.includes("11111111"), false);
});

test("safeDetail redacts tokens and jwt", () => {
  const jwt = "aaa." + "b".repeat(80) + ".ccc";
  const out = safeDetail({ access_token: "abc", nested: { refresh: "xyz" }, token: jwt });
  assert.equal(out.access_token, "<redacted>");
  assert.equal(out.nested.refresh, "<redacted>");
  assert.equal(out.token, "<redacted-jwt>");
});

test("grantFromRecord requires oauth grant", () => {
  assert.equal(grantFromRecord(undefined), null);
  assert.equal(grantFromRecord({ kind: "grant", payload: { type: "oauth" } }), null);
  const grant = grantFromRecord({
    kind: "grant",
    payload: { type: "oauth", access: "a", refresh: "b", expires: 1 },
  });
  assert.equal(grant.access, "a");
});
