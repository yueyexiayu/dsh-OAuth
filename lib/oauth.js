import {
  OPENAI_CLIENT_ID,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_DEVICE_USERCODE_URL,
  OPENAI_DEVICE_VERIFICATION_URL,
  OPENAI_MODELS_URL,
  OPENAI_TOKEN_URL,
  USER_AGENT,
  XAI_CLIENT_ID,
  XAI_DEVICE_URL,
  XAI_MODELS_URL,
  XAI_REFRESH_SKEW_MS,
  XAI_SCOPE,
  XAI_TOKEN_URL,
  accountIdFromJwt,
  safeDetail,
} from "./parse.js";

const FETCH_MS = 30_000;

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
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (error) {
    return { ok: false, status: 0, body: error && error.message ? error.message : "network error" };
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

export async function xaiStart() {
  const res = await requestJson(XAI_DEVICE_URL, {
    method: "POST",
    form: { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "pi" },
  });
  if (!res.ok || !res.body || typeof res.body.device_code !== "string") {
    throw new Error(`xAI 申请设备码失败 (HTTP ${res.status})`);
  }
  const interval = Number(res.body.interval);
  return {
    provider: "xai",
    deviceCode: res.body.device_code,
    userCode: typeof res.body.user_code === "string" ? res.body.user_code : "",
    verificationUri: res.body.verification_uri_complete || res.body.verification_uri,
    interval: interval > 0 ? interval : 5,
  };
}

export async function xaiPollOnce(deviceCode) {
  const res = await requestJson(XAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    },
  });
  if (res.ok && res.body && res.body.access_token && res.body.refresh_token) {
    const expiresIn = Number(res.body.expires_in);
    return {
      done: true,
      payload: {
        type: "oauth",
        access: res.body.access_token,
        refresh: res.body.refresh_token,
        expires: Date.now() + ((expiresIn > 0 ? expiresIn : 3600) * 1000) - XAI_REFRESH_SKEW_MS,
      },
    };
  }
  const error = res.body && res.body.error;
  if (error === "authorization_pending") return { done: false, slowDown: false };
  if (error === "slow_down") return { done: false, slowDown: true };
  if (error === "access_denied" || error === "authorization_denied") throw new Error("xAI 授权被拒绝");
  if (error === "expired_token") throw new Error("xAI 设备码已过期，请重新登录");
  throw new Error(`xAI 轮询失败 (HTTP ${res.status})`);
}

export async function xaiRefresh(grant) {
  const res = await requestJson(XAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      client_id: XAI_CLIENT_ID,
      refresh_token: grant.refresh,
    },
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`xAI 刷新失败 (HTTP ${res.status})`);
  }
  const expiresIn = Number(res.body.expires_in);
  return {
    type: "oauth",
    access: res.body.access_token,
    refresh: res.body.refresh_token || grant.refresh,
    expires: Date.now() + ((expiresIn > 0 ? expiresIn : 3600) * 1000) - XAI_REFRESH_SKEW_MS,
  };
}

export async function openaiStart() {
  const res = await requestJson(OPENAI_DEVICE_USERCODE_URL, {
    method: "POST",
    json: { client_id: OPENAI_CLIENT_ID },
  });
  if (!res.ok || !res.body || typeof res.body.device_auth_id !== "string" || typeof res.body.user_code !== "string") {
    throw new Error(`OpenAI Codex 申请设备码失败 (HTTP ${res.status})`);
  }
  const interval = Number(res.body.interval);
  return {
    provider: "openai-codex",
    deviceAuthId: res.body.device_auth_id,
    userCode: res.body.user_code,
    verificationUri: OPENAI_DEVICE_VERIFICATION_URL,
    interval: interval >= 0 ? interval : 5,
  };
}

export async function openaiPollOnce(deviceAuthId, userCode) {
  const res = await requestJson(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    json: { device_auth_id: deviceAuthId, user_code: userCode },
  });
  if (res.ok && res.body && res.body.authorization_code && res.body.code_verifier) {
    return { done: true, payload: await openaiExchange(res.body.authorization_code, res.body.code_verifier) };
  }
  const error = res.body && res.body.error;
  const errorCode = error && typeof error === "object" ? error.code : error;
  if (res.status === 403 || res.status === 404 || errorCode === "deviceauth_authorization_pending") {
    return { done: false, slowDown: false };
  }
  if (errorCode === "slow_down") return { done: false, slowDown: true };
  throw new Error(`OpenAI Codex 轮询失败 (HTTP ${res.status})`);
}

async function openaiExchange(authorizationCode, codeVerifier) {
  const res = await requestJson(OPENAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    },
  });
  if (!res.ok || !res.body || !res.body.access_token || !res.body.refresh_token) {
    throw new Error(`OpenAI Codex 换 token 失败 (HTTP ${res.status})`);
  }
  const accountId = accountIdFromJwt(res.body.access_token);
  if (!accountId) throw new Error("OpenAI access token 中没有 chatgpt_account_id");
  const expiresIn = Number(res.body.expires_in);
  return {
    type: "oauth",
    access: res.body.access_token,
    refresh: res.body.refresh_token,
    expires: Date.now() + (expiresIn > 0 ? expiresIn : 3600) * 1000,
    accountId,
  };
}

export async function openaiRefresh(grant) {
  const res = await requestJson(OPENAI_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      refresh_token: grant.refresh,
      client_id: OPENAI_CLIENT_ID,
    },
  });
  if (!res.ok || !res.body || !res.body.access_token || !res.body.refresh_token) {
    throw new Error(`OpenAI Codex 刷新失败 (HTTP ${res.status})`);
  }
  const accountId = accountIdFromJwt(res.body.access_token) || grant.accountId;
  if (!accountId) throw new Error("刷新后的 OpenAI token 没有 chatgpt_account_id");
  const expiresIn = Number(res.body.expires_in);
  return {
    type: "oauth",
    access: res.body.access_token,
    refresh: res.body.refresh_token,
    expires: Date.now() + (expiresIn > 0 ? expiresIn : 3600) * 1000,
    accountId,
  };
}

export async function verifyGrant(platform, grant) {
  const headers = { authorization: `Bearer ${grant.access}` };
  if (platform.id === "xai") {
    const res = await requestJson(XAI_MODELS_URL, { headers });
    return Boolean(res.ok && res.body && Array.isArray(res.body.data));
  }
  if (!grant.accountId) return false;
  const res = await requestJson(OPENAI_MODELS_URL, {
    headers: { ...headers, "ChatGPT-Account-Id": grant.accountId },
  });
  return res.ok;
}

export { safeDetail };
