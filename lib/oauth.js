import {
  OPENAI_CLIENT_ID,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_DEVICE_USERCODE_URL,
  OPENAI_DEVICE_VERIFICATION_URL,
  OPENAI_MODELS_URL,
  OPENAI_REVOKE_URL,
  OPENAI_TOKEN_URL,
  USER_AGENT,
  XAI_CLIENT_ID,
  XAI_DEVICE_URL,
  XAI_MODELS_URL,
  XAI_REFRESH_SKEW_MS,
  XAI_REVOKE_URL,
  XAI_SCOPE,
  XAI_TOKEN_URL,
  XAI_VERIFICATION_HOST,
  accountIdFromJwt,
  safeDetail,
} from "./parse.js";

const FETCH_MS = 30_000;
// The installed pi-ai OAuth implementation and openai/codex device_code_auth.rs
// both cap OpenAI device authorization at 15 minutes (no expires_in is required).
const OPENAI_DEVICE_SECONDS = 15 * 60;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(value, field) {
  if (!nonEmptyString(value)) throw new Error(`OAuth 响应缺少有效 ${field}`);
  return value;
}

function expiresAt(seconds, skew = 0) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("OAuth 响应包含无效 expires_in");
  }
  const expires = Date.now() + seconds * 1000 - skew;
  if (!Number.isFinite(expires) || expires <= 0 || expires > 8.64e15) {
    throw new Error("OAuth 响应包含无效 expires_in");
  }
  return expires;
}

function verificationUri(value) {
  requireString(value, "verification_uri");
  let url;
  try { url = new URL(value); } catch { throw new Error("xAI 授权链接无效"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("xAI 授权链接必须使用 HTTPS 且不能包含用户信息");
  }
  if (url.hostname !== XAI_VERIFICATION_HOST || (url.port && url.port !== "443")) {
    throw new Error("xAI 授权链接主机不受信任");
  }
  url.searchParams.delete("device_code");
  url.hash = "";
  return url.href;
}

function xaiPayload(body, previousRefresh) {
  return {
    type: "oauth",
    access: requireString(body.access_token, "access_token"),
    refresh: requireString(body.refresh_token === undefined ? previousRefresh : body.refresh_token, "refresh_token"),
    // pi-ai defaults only an omitted xAI lifetime, never an invalid reported value.
    expires: expiresAt(body.expires_in === undefined ? 3600 : body.expires_in, XAI_REFRESH_SKEW_MS),
  };
}

function openaiPayload(body, previousAccountId) {
  const access = requireString(body.access_token, "access_token");
  const accountId = accountIdFromJwt(access) || previousAccountId;
  return {
    type: "oauth",
    access,
    refresh: requireString(body.refresh_token, "refresh_token"),
    expires: expiresAt(body.expires_in),
    accountId: requireString(accountId, "chatgpt_account_id"),
  };
}

export async function requestJson(url, options = {}) {
  const headers = {
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...(options.headers || {}),
  };
  let body;
  if (options.json) {
    body = JSON.stringify(options.json);
    headers["content-type"] = "application/json";
  } else if (options.form) {
    body = new URLSearchParams(options.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_MS)])
        : AbortSignal.timeout(FETCH_MS),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    return { ok: false, status: 0, body: error && error.message ? error.message : "network error" };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    return { ok: false, status: response.status, body: null, error: "invalid JSON response" };
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

export async function xaiStart(signal) {
  const res = await requestJson(XAI_DEVICE_URL, {
    method: "POST",
    signal,
    form: { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "pi" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`xAI 申请设备码失败 (HTTP ${res.status})`);
  }
  const interval = Number(res.body.interval);
  const uri = verificationUri(res.body.verification_uri);
  const completeUri = res.body.verification_uri_complete;
  return {
    provider: "xai",
    deviceCode: requireString(res.body.device_code, "device_code"),
    userCode: requireString(res.body.user_code, "user_code"),
    verificationUri: completeUri === undefined || completeUri === "" ? uri : verificationUri(completeUri),
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
    expiresAt: expiresAt(res.body.expires_in),
  };
}

export async function xaiPollOnce(deviceCode, signal) {
  requireString(deviceCode, "device_code");
  const res = await requestJson(XAI_TOKEN_URL, {
    method: "POST",
    signal,
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    },
  });
  if (res.ok && res.body) return { done: true, payload: xaiPayload(res.body) };
  const error = res.body && res.body.error;
  if (error === "authorization_pending") return { done: false, slowDown: false };
  if (error === "slow_down") return { done: false, slowDown: true };
  if (error === "access_denied" || error === "authorization_denied") throw new Error("xAI 授权被拒绝");
  if (error === "expired_token") throw new Error("xAI 设备码已过期，请重新登录");
  throw new Error(`xAI 轮询失败 (HTTP ${res.status})`);
}

export async function xaiRefresh(grant, signal) {
  requireString(grant?.refresh, "refresh_token");
  const res = await requestJson(XAI_TOKEN_URL, {
    method: "POST",
    signal,
    form: {
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: grant.refresh,
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`xAI 刷新失败 (HTTP ${res.status})`);
  }
  return xaiPayload(res.body, grant.refresh);
}

export async function openaiStart(signal) {
  const res = await requestJson(OPENAI_DEVICE_USERCODE_URL, {
    method: "POST",
    signal,
    json: { client_id: OPENAI_CLIENT_ID },
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI Codex 申请设备码失败 (HTTP ${res.status})`);
  }
  const interval = Number(res.body.interval);
  return {
    provider: "openai-codex",
    deviceAuthId: requireString(res.body.device_auth_id, "device_auth_id"),
    userCode: requireString(res.body.user_code, "user_code"),
    verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
    interval: Number.isFinite(interval) && interval >= 0 ? interval : 5,
    expiresAt: expiresAt(res.body.expires_in === undefined ? OPENAI_DEVICE_SECONDS : res.body.expires_in),
  };
}

export async function openaiPollOnce(deviceAuthId, userCode, signal) {
  requireString(deviceAuthId, "device_auth_id");
  requireString(userCode, "user_code");
  const res = await requestJson(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    signal,
    json: { device_auth_id: deviceAuthId, user_code: userCode },
  });
  const error = res.body && res.body.error;
  const errorCode = error && typeof error === "object" ? error.code : error;
  // Explicit terminal errors win over the legacy 403/404 pending convention.
  if (errorCode === "slow_down") return { done: false, slowDown: true };
  if (errorCode === "deviceauth_authorization_pending" || errorCode === "authorization_pending") {
    return { done: false, slowDown: false };
  }
  if (error != null) {
    if (typeof errorCode === "string" && errorCode.includes("expired")) throw new Error("OpenAI Codex 设备码已过期，请重新登录");
    if (typeof errorCode === "string" && errorCode.includes("denied")) throw new Error("OpenAI Codex 授权被拒绝");
    throw new Error(`OpenAI Codex 轮询失败 (HTTP ${res.status})`);
  }
  if (res.ok && res.body) {
    const code = requireString(res.body.authorization_code, "authorization_code");
    const verifier = requireString(res.body.code_verifier, "code_verifier");
    return { done: true, payload: await openaiExchange(code, verifier, signal) };
  }
  if (res.status === 403 || res.status === 404) return { done: false, slowDown: false };
  throw new Error(`OpenAI Codex 轮询失败 (HTTP ${res.status})`);
}

async function openaiExchange(authorizationCode, codeVerifier, signal) {
  const res = await requestJson(OPENAI_TOKEN_URL, {
    method: "POST",
    signal,
    form: {
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI Codex 换 token 失败 (HTTP ${res.status})`);
  }
  return openaiPayload(res.body);
}

export async function openaiRefresh(grant, signal) {
  requireString(grant?.refresh, "refresh_token");
  const res = await requestJson(OPENAI_TOKEN_URL, {
    method: "POST",
    signal,
    form: {
      grant_type: "refresh_token",
      refresh_token: grant.refresh,
      client_id: OPENAI_CLIENT_ID,
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI Codex 刷新失败 (HTTP ${res.status})`);
  }
  return openaiPayload(res.body, grant.accountId);
}

export async function verifyGrant(platform, grant, signal) {
  if (!nonEmptyString(grant?.access)) return false;
  const headers = { authorization: `Bearer ${grant.access}` };
  if (platform.id === "xai") {
    const res = await requestJson(XAI_MODELS_URL, { headers, signal });
    return Boolean(res.ok && res.body && Array.isArray(res.body.data));
  }
  if (!nonEmptyString(grant.accountId)) return false;
  const res = await requestJson(OPENAI_MODELS_URL, {
    signal,
    headers: { ...headers, "ChatGPT-Account-Id": grant.accountId },
  });
  // Codex ModelsResponse uses models: ModelInfo[], not the API's data array.
  return Boolean(res.ok && res.body && Array.isArray(res.body.models) &&
    res.body.models.every((model) => model && nonEmptyString(model.slug)));
}

export async function revokeGrant(platformId, grant, signal) {
  const refresh = nonEmptyString(grant?.refresh) ? grant.refresh : "";
  const access = nonEmptyString(grant?.access) ? grant.access : "";
  const token = refresh || access;
  if (!token) return { ok: true, skipped: true };
  const url = platformId === "xai" ? XAI_REVOKE_URL : OPENAI_REVOKE_URL;
  const clientId = platformId === "xai" ? XAI_CLIENT_ID : OPENAI_CLIENT_ID;
  const res = await requestJson(url, {
    method: "POST",
    signal,
    form: {
      token,
      token_type_hint: refresh ? "refresh_token" : "access_token",
      client_id: clientId,
    },
  });
  if (res.ok || res.status === 200 || res.status === 204) return { ok: true };
  const error = res.body && typeof res.body === "object" ? res.body.error : "";
  if (res.status === 400 && (error === "invalid_token" || error === "unsupported_token_type")) {
    return { ok: true };
  }
  const status = Number.isInteger(res.status) ? res.status : 0;
  return {
    ok: false,
    message: status > 0
      ? `远端吊销失败 (HTTP ${status})，本地凭据已删除`
      : "远端吊销失败，本地凭据已删除",
  };
}

export { safeDetail };
