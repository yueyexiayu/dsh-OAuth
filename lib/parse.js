export const API_PATH = "/api/OAuth";
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const PLATFORMS = {
  grok: {
    id: "xai",
    label: "Grok",
    recordKey: "llm-pi-ai/xai",
    models: [{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 500000, maxTokens: 500000 }],
  },
  gpt: {
    id: "openai-codex",
    label: "GPT",
    recordKey: "llm-pi-ai/openai-codex",
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272000 },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 272000 },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 272000 },
      { id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 272000 },
    ],
  },
};

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_MODELS_URL = "https://api.x.ai/v1/models";
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const OPENAI_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const OPENAI_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const OPENAI_JWT_CLAIM = "https://api.openai.com/auth";
export const OPENAI_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0";
export const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
export const XAI_USERINFO_URL = "https://auth.x.ai/userinfo";

export function platformOf(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "grok" || key === "xai") return PLATFORMS.grok;
  if (key === "gpt" || key === "chatgpt" || key === "codex" || key === "openai-codex") return PLATFORMS.gpt;
  return null;
}

export function looksLikeOpaqueId(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
  if (/^[0-9a-f]{16,}$/i.test(text)) return true;
  return false;
}

export function pickDisplayName(...candidates) {
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || looksLikeOpaqueId(value)) continue;
    return value;
  }
  return null;
}

export function decodeJwtPayload(access) {
  try {
    const parts = String(access).split(".");
    if (parts.length < 2) return null;
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

export function accountIdFromJwt(access) {
  const json = decodeJwtPayload(access);
  const auth = json && json[OPENAI_JWT_CLAIM];
  const id = auth && auth.chatgpt_account_id;
  return typeof id === "string" && id ? id : null;
}

export function displayNameFromJwt(access) {
  const json = decodeJwtPayload(access);
  if (!json) return null;
  const profile = json["https://api.openai.com/profile"] && typeof json["https://api.openai.com/profile"] === "object"
    ? json["https://api.openai.com/profile"]
    : {};
  return pickDisplayName(
    json.email,
    profile.email,
    json.preferred_username,
    json.name,
    profile.name,
  );
}

export function grantFromRecord(record) {
  if (!record || record.kind !== "grant" || !record.payload || typeof record.payload !== "object") {
    return null;
  }
  const payload = record.payload;
  const access = typeof payload.access === "string" && payload.access ? payload.access : null;
  const refresh = typeof payload.refresh === "string" && payload.refresh ? payload.refresh : null;
  if (!access || !refresh) return null;
  const accountId =
    (typeof payload.accountId === "string" && payload.accountId) ||
    accountIdFromJwt(access);
  const expires = Number(payload.expires);
  return {
    access,
    refresh,
    accountId: accountId || null,
    expires: Number.isFinite(expires) ? expires : null,
  };
}

export function publicAccount(grant, displayName) {
  if (!grant) return { loggedIn: false, account: null, expired: false };
  const expired = typeof grant.expires === "number" && grant.expires <= Date.now();
  const account = pickDisplayName(displayName, displayNameFromJwt(grant.access));
  return {
    loggedIn: true,
    account,
    expired,
  };
}

const SENSITIVE = new Set([
  "access",
  "access_token",
  "refresh",
  "refresh_token",
  "id_token",
  "api_key",
  "authorization_code",
  "code_verifier",
]);

export function safeDetail(value) {
  if (Array.isArray(value)) return value.map(safeDetail);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE.has(key.toLowerCase()) ? "<redacted>" : safeDetail(item);
    }
    return out;
  }
  if (typeof value === "string") {
    const parts = value.split(".");
    if (parts.length === 3 && value.length > 60) return "<redacted-jwt>";
  }
  return value;
}
