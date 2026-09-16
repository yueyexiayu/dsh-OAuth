import {
  openaiPollOnce,
  openaiRefresh,
  openaiStart,
  verifyGrant,
  xaiPollOnce,
  xaiRefresh,
  xaiStart,
} from "./oauth.js";
import {
  API_PATH,
  GROK_USER_URL,
  USER_AGENT,
  XAI_USERINFO_URL,
  grantFromRecord,
  displayNameFromIdentity,
  platformOf,
  publicAccount,
} from "./parse.js";

export const name = "OAuth";
export const inject = ["connection", "credentials"];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fail(status, error) {
  return jsonResponse(status, { ok: false, error });
}

function currentSelection(ctx, sessionId) {
  if (sessionId) {
    try {
      const agents = ctx.get("agents");
      const agent = agents && agents.get(String(sessionId));
      const header = agent && agent.session ? agent.session.requestHeader() : null;
      const cfg = header && header.config;
      if (cfg && typeof cfg.provider === "string") {
        return cfg.provider;
      }
    } catch {
      // fall through
    }
  }
  try {
    const agentDefaultModel = ctx.get("agentDefaultModel");
    const sel = agentDefaultModel && agentDefaultModel.currentSelection && agentDefaultModel.currentSelection();
    if (sel && typeof sel.provider === "string") return sel.provider;
  } catch {
    // fall through
  }
  try {
    const settings = ctx.get("settings");
    const sel = settings && settings.get && settings.get("agent-default-model");
    if (sel && typeof sel.provider === "string") return sel.provider;
  } catch {
    // ignore
  }
  return null;
}

function platformKeyForProvider(provider) {
  if (provider === "xai") return "grok";
  if (provider === "openai-codex") return "gpt";
  return null;
}

function publicPending(pending) {
  if (!pending) return null;
  return {
    platform: pending.platformKey,
    label: pending.platform.label,
    userCode: pending.userCode || "",
    verificationUri: pending.verificationUri,
    error: pending.error || null,
  };
}

export function apply(ctx) {
  let pending = null;
  let timer = null;
  const profileCache = Object.create(null);

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(ms) {
    stopTimer();
    timer = setTimeout(() => {
      void tick();
    }, Math.max(1000, ms));
  }

  async function readGrant(platform) {
    try {
      return grantFromRecord(await ctx.credentials.readRecord(platform.recordKey));
    } catch {
      return null;
    }
  }

  async function writeGrant(platform, payload) {
    await ctx.credentials.modifyRecord(platform.recordKey, async () => ({
      kind: "grant",
      payload,
    }));
    ensureRoute(platform);
  }

  function ensureRoute(platform) {
    try {
      const settings = ctx.get("settings");
      if (!settings || typeof settings.get !== "function" || typeof settings.set !== "function") return;
      const llm = settings.get("llm-pi-ai") || {};
      const providers = { ...(llm.providers || {}) };
      if (providers[platform.id]) return;
      providers[platform.id] = { models: platform.models };
      settings.set("llm-pi-ai", { ...llm, providers });
    } catch {
      // keep login even if settings cannot be patched
    }
  }

  async function fetchGrokDisplay(grant) {
    const headers = {
      authorization: `Bearer ${grant.access}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-version": "0.1.0",
      "x-grok-client-mode": "headless",
    };
    const tryUrl = async (url) => {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      return displayNameFromIdentity(await response.json());
    };
    const settled = await Promise.allSettled([tryUrl(GROK_USER_URL), tryUrl(XAI_USERINFO_URL)]);
    for (const item of settled) {
      if (item.status === "fulfilled" && item.value) return item.value;
    }
    return null;
  }

  async function displayFor(platform, grant) {
    if (!grant) return null;
    const cached = profileCache[platform.id];
    const ttl = cached && cached.name ? 5 * 60 * 1000 : 30 * 1000;
    if (cached && Date.now() - cached.at < ttl) return cached.name;
    if (platform.id !== "xai") return null;
    if (!profileCache.loading) {
      profileCache.loading = fetchGrokDisplay(grant)
        .then((name) => {
          profileCache[platform.id] = { at: Date.now(), name };
          return name;
        })
        .finally(() => {
          profileCache.loading = null;
        });
    }
    return await profileCache.loading;
  }

  async function statusBody(sessionId) {
    const shownKey = platformKeyForProvider(currentSelection(ctx, sessionId));
    const pendingInfo = publicPending(pending);
    if (!shownKey && !pendingInfo) {
      return { ok: true, isSupported: false, platform: null, account: null, pending: null };
    }
    const key = shownKey || pendingInfo.platform;
    const platform = platformOf(key);
    const grant = platform ? await readGrant(platform) : null;
    return {
      ok: true,
      isSupported: Boolean(shownKey),
      platform: key,
      account: platform ? publicAccount(grant, await displayFor(platform, grant)) : null,
      pending: pendingInfo,
    };
  }

  async function tick() {
    if (!pending || pending.error) return;
    try {
      const result =
        pending.platform.id === "xai"
          ? await xaiPollOnce(pending.deviceCode)
          : await openaiPollOnce(pending.deviceAuthId, pending.userCode);
      if (result.slowDown) pending.interval += 5;
      if (result.done) {
        await writeGrant(pending.platform, result.payload);
        pending = null;
        stopTimer();
        return;
      }
      schedule(pending.interval * 1000);
    } catch (error) {
      pending.error = error && error.message ? error.message : "授权失败";
      stopTimer();
    }
  }

  async function startLogin(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    stopTimer();
    const started = platform.id === "xai" ? await xaiStart() : await openaiStart();
    pending = {
      platformKey: platformKey === "gpt" || platform.id === "openai-codex" ? "gpt" : "grok",
      platform,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      interval: started.interval || 5,
      deviceCode: started.deviceCode,
      deviceAuthId: started.deviceAuthId,
      error: null,
    };
    schedule(pending.interval * 1000);
  }

  async function logout(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    await ctx.credentials.deleteRecord(platform.recordKey);
  }

  async function refresh(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    const grant = await readGrant(platform);
    if (!grant) throw new Error("未登录");
    const payload = platform.id === "xai" ? await xaiRefresh(grant) : await openaiRefresh(grant);
    await writeGrant(platform, payload);
    const ok = await verifyGrant(platform, { ...grant, ...payload });
    if (!ok) throw new Error("刷新后验证失败");
  }

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        const url = new URL(request.url);
        const sessionId = url.searchParams.get("sessionId") || "";
        if (request.method === "GET") return jsonResponse(200, await statusBody(sessionId));
        const raw = await request.text();
        let body = {};
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return fail(400, "invalid json");
          }
        }
        const sid = body.sessionId || sessionId;
        const action = body.action;
        if (action === "start") {
          await startLogin(body.platform);
          return jsonResponse(200, await statusBody(sid));
        }
        if (action === "cancel") {
          stopTimer();
          pending = null;
          return jsonResponse(200, await statusBody(sid));
        }
        if (action === "logout") {
          await logout(body.platform);
          return jsonResponse(200, await statusBody(sid));
        }
        if (action === "refresh") {
          await refresh(body.platform);
          return jsonResponse(200, await statusBody(sid));
        }
        return fail(400, "unknown action");
      } catch (error) {
        return fail(502, error && error.message ? error.message : String(error));
      }
    },
  });
}
