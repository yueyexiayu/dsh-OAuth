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
  safeDetail,
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
    const sel = settings?.describe({ redactSecrets: true }).find((row) => row.ns === "agent-default-model")?.value;
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
  const lifetime = new AbortController();
  const profileCache = Object.create(null);

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function cancelLogin() {
    stopTimer();
    pending?.controller.abort();
    pending = null;
  }

  ctx.effect(() => () => {
    lifetime.abort();
    cancelLogin();
  });

  function schedule(attempt, ms) {
    if (pending !== attempt || attempt.controller.signal.aborted) return;
    stopTimer();
    timer = setTimeout(() => {
      void tick(attempt);
    }, Math.max(1000, ms));
  }

  async function readGrant(platform) {
    return grantFromRecord(await ctx.credentials.readRecord(platform.recordKey));
  }

  async function writeGrant(attempt, payload) {
    await ctx.credentials.modifyRecord(attempt.platform.recordKey, async () => {
      attempt.controller.signal.throwIfAborted();
      return { kind: "grant", payload };
    });
    delete profileCache[attempt.platform.id];
    await ensureRoute(attempt.platform);
  }

  async function ensureRoute(platform) {
    const settings = ctx.get("settings");
    if (!settings) throw new Error("凭据已保存，但未加载 settings，无法补充模型路由");
    const provider = ctx.get("llm")?.listConfigurableProviders().find((row) => row.provider === platform.id);
    const ns = provider?.settingsNs ?? "llm-pi-ai";
    const path = provider?.settingsPath ?? ["providers", platform.id];
    for (let attempt = 0; attempt < 3; attempt++) {
      const descriptor = settings.describe({ redactSecrets: true }).find((row) => row.ns === ns);
      if (!descriptor) throw new Error(`凭据已保存，但模型路由配置 ${ns} 不可用`);
      let value = descriptor.value;
      for (const key of path) {
        value = value && Object.hasOwn(value, key) ? value[key] : undefined;
      }
      if (value !== undefined) return;
      try {
        // An empty profile inherits the installed official provider/model catalog.
        await settings.mutate(ns, [{ op: "set", path, value: {} }], descriptor.revision);
        return;
      } catch (error) {
        if (error?.code !== "SETTINGS_CONFLICT" || attempt === 2) {
          throw new Error(`凭据已保存，但模型路由配置失败：${safeDetail(error?.message ?? error)}`);
        }
      }
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
      const response = await fetch(url, { headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)]) });
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
    if (cached && cached.access === grant.access && Date.now() - cached.at < ttl) return cached.promise ?? cached.name;
    if (platform.id !== "xai") return null;
    const entry = { access: grant.access, at: Date.now(), name: null };
    profileCache[platform.id] = entry;
    entry.promise = fetchGrokDisplay(grant).then((name) => {
      entry.name = name;
      delete entry.promise;
      return name;
    });
    return await entry.promise;
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

  async function tick(attempt) {
    if (pending !== attempt || attempt.error || attempt.controller.signal.aborted) return;
    try {
      const result =
        attempt.platform.id === "xai"
          ? await xaiPollOnce(attempt.deviceCode, attempt.controller.signal)
          : await openaiPollOnce(attempt.deviceAuthId, attempt.userCode, attempt.controller.signal);
      if (pending !== attempt || attempt.controller.signal.aborted) return;
      if (result.slowDown) attempt.interval += 5;
      if (result.done) {
        await writeGrant(attempt, result.payload);
        if (pending === attempt) cancelLogin();
        return;
      }
      schedule(attempt, attempt.interval * 1000);
    } catch (error) {
      if (pending !== attempt || attempt.controller.signal.aborted) return;
      attempt.error = safeDetail(error?.message ?? "授权失败");
      stopTimer();
    }
  }

  async function startLogin(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    cancelLogin();
    const attempt = {
      platformKey: platformKey === "gpt" || platform.id === "openai-codex" ? "gpt" : "grok",
      platform,
      controller: new AbortController(),
      error: null,
    };
    pending = attempt;
    let started;
    try {
      started = platform.id === "xai"
        ? await xaiStart(attempt.controller.signal)
        : await openaiStart(attempt.controller.signal);
    } catch (error) {
      if (pending === attempt && !attempt.controller.signal.aborted) {
        attempt.error = safeDetail(error?.message ?? "申请设备码失败");
      }
      throw error;
    }
    attempt.controller.signal.throwIfAborted();
    Object.assign(attempt, {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      interval: started.interval || 5,
      deviceCode: started.deviceCode,
      deviceAuthId: started.deviceAuthId,
    });
    schedule(attempt, attempt.interval * 1000);
  }

  async function logout(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    if (pending?.platform.id === platform.id) cancelLogin();
    await ctx.credentials.deleteRecord(platform.recordKey);
    delete profileCache[platform.id];
  }

  async function refresh(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    const updated = await ctx.credentials.modifyRecord(platform.recordKey, async (current) => {
      lifetime.signal.throwIfAborted();
      const grant = grantFromRecord(current);
      if (!grant) throw new Error("未登录");
      const payload = platform.id === "xai"
        ? await xaiRefresh(grant, lifetime.signal)
        : await openaiRefresh(grant, lifetime.signal);
      return { kind: "grant", payload };
    });
    delete profileCache[platform.id];
    // A refresh may rotate the token. Persist it even if the models endpoint
    // is temporarily unavailable; retaining the old refresh token loses login.
    lifetime.signal.throwIfAborted();
    const ok = await verifyGrant(platform, grantFromRecord(updated), lifetime.signal);
    if (!ok) throw new Error("凭据已更新，但刷新后验证失败");
    await ensureRoute(platform);
  }

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        if (lifetime.signal.aborted) return fail(503, "OAuth 插件已卸载");
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
          cancelLogin();
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
        return fail(502, safeDetail(error?.message ?? String(error)));
      }
    },
  });
}
