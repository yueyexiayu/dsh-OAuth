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
export const inject = ["connection", "credentials", "authorization"];

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

function slotKey(platform) {
  return platform.id === "xai" ? "grok" : "gpt";
}

function sessionKey(sessionId) {
  return String(sessionId || "");
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
  const pendings = new Map();
  const lifetime = new AbortController();
  const profileCache = Object.create(null);
  const seenSecrets = [];

  function remember(...values) {
    for (const value of values) {
      if (typeof value === "string" && value && !seenSecrets.includes(value)) seenSecrets.push(value);
    }
  }

  function redact(value) {
    return safeDetail(value, seenSecrets);
  }

  function isCurrent(attempt) {
    return pendings.get(attempt.platformKey) === attempt;
  }

  function stopTimer(attempt) {
    if (attempt?.timer) {
      clearTimeout(attempt.timer);
      attempt.timer = null;
    }
  }

  function clearDeadline(attempt) {
    if (attempt?.deadlineTimer != null) {
      clearTimeout(attempt.deadlineTimer);
      attempt.deadlineTimer = null;
    }
  }

  function cancelPlatform(platformKey) {
    const attempt = pendings.get(platformKey);
    if (!attempt) return;
    stopTimer(attempt);
    clearDeadline(attempt);
    attempt.controller.abort();
    pendings.delete(platformKey);
  }

  function cancelAll() {
    for (const key of [...pendings.keys()]) cancelPlatform(key);
  }

  function cancelSession(sessionId) {
    const sid = sessionKey(sessionId);
    for (const [key, attempt] of [...pendings.entries()]) {
      if (attempt.sessionId === sid) cancelPlatform(key);
    }
  }

  async function cancelOfficial(platform) {
    const authorization = ctx.get("authorization");
    if (!authorization || typeof authorization.cancel !== "function") {
      throw new Error("官方 authorization 服务不可用，无法协调账号授权");
    }
    lifetime.signal.throwIfAborted();
    const key = platform.recordKey;
    if (!authorization.describe?.(key)?.inFlight) {
      authorization.cancel(key);
      return;
    }
    // Subscribe before cancellation. Installed pi-ai can already have accepted
    // a login result whose continuation has not queued its credential write.
    // Settlement is the barrier after that continuation, not cancel() itself.
    let unwatch;
    let abort;
    try {
      const settled = new Promise((resolve, reject) => {
        unwatch = ctx.on("authorization/settled", (settledKey) => {
          if (settledKey === key) resolve();
        });
        abort = () => reject(lifetime.signal.reason);
        lifetime.signal.addEventListener("abort", abort, { once: true });
      });
      authorization.cancel(key);
      await settled;
    } finally {
      unwatch?.();
      if (abort) lifetime.signal.removeEventListener("abort", abort);
    }
  }

  function expire(attempt) {
    if (!isCurrent(attempt)) return;
    stopTimer(attempt);
    clearDeadline(attempt);
    attempt.error = `${attempt.platform.label} 设备码已过期，请重新登录`;
    attempt.controller.abort();
  }

  function armDeadline(attempt) {
    const left = attempt.expiresAt - Date.now();
    if (left <= 0) return expire(attempt);
    attempt.deadlineTimer = setTimeout(() => armDeadline(attempt), Math.min(left, 2 ** 31 - 1));
  }

  function checkAttempt(attempt) {
    if (Date.now() >= attempt.expiresAt) expire(attempt);
    attempt.controller.signal.throwIfAborted();
  }

  ctx.effect(() => () => {
    lifetime.abort();
    cancelAll();
  });

  function schedule(attempt, ms) {
    if (!isCurrent(attempt) || attempt.controller.signal.aborted) return;
    stopTimer(attempt);
    attempt.timer = setTimeout(() => {
      void tick(attempt);
    }, Math.max(1000, ms));
  }

  async function readGrant(platform) {
    const grant = grantFromRecord(await ctx.credentials.readRecord(platform.recordKey));
    remember(grant?.access, grant?.refresh);
    return grant;
  }

  async function writeGrant(attempt, payload) {
    remember(payload?.access, payload?.refresh);
    try {
      await ctx.credentials.modifyRecord(attempt.platform.recordKey, async () => {
        checkAttempt(attempt);
        clearDeadline(attempt);
        return { kind: "grant", payload };
      });
    } catch (error) {
      throw new Error(safeDetail(error?.message ?? "凭据保存失败", [payload.access, payload.refresh]));
    }
    delete profileCache[attempt.platform.id];
    try {
      await ensureRoute(attempt.platform);
    } catch (error) {
      throw new Error(safeDetail(error?.message ?? "模型路由配置失败", [payload.access, payload.refresh]));
    }
  }

  function routeSnapshot(platform) {
    const settings = ctx.get("settings");
    const provider = ctx.get("llm")?.listConfigurableProviders().find((row) => row.provider === platform.id);
    const ns = provider?.settingsNs ?? "llm-pi-ai";
    const path = provider?.settingsPath ?? ["providers", platform.id];
    const descriptor = settings?.describe({ redactSecrets: true }).find((row) => row.ns === ns);
    let value = descriptor?.value;
    for (const key of path) {
      value = value && Object.hasOwn(value, key) ? value[key] : undefined;
    }
    return { settings, ns, path, descriptor, value };
  }

  async function ensureRoute(platform) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { settings, ns, path, descriptor, value } = routeSnapshot(platform);
      if (!settings) throw new Error("凭据已保存，但未加载 settings，无法补充模型路由");
      if (!descriptor) throw new Error(`凭据已保存，但模型路由配置 ${ns} 不可用`);
      if (value !== undefined) return;
      try {
        // An empty profile inherits the installed official provider/model catalog.
        await settings.mutate(ns, [{ op: "set", path, value: {} }], descriptor.revision);
        return;
      } catch (error) {
        if (error?.code !== "SETTINGS_CONFLICT" || attempt === 2) {
          throw new Error(`凭据已保存，但模型路由配置失败：${redact(error?.message ?? error)}`);
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

  function visibleAttempt(sessionId, shownKey) {
    const sid = sessionKey(sessionId);
    if (shownKey) {
      const attempt = pendings.get(shownKey);
      return attempt && attempt.sessionId === sid ? attempt : null;
    }
    const owned = [];
    for (const attempt of pendings.values()) {
      if (attempt.sessionId === sid) owned.push(attempt);
    }
    return owned.length === 1 ? owned[0] : null;
  }

  async function statusBody(sessionId) {
    const shownKey = platformKeyForProvider(currentSelection(ctx, sessionId));
    const pendingInfo = publicPending(visibleAttempt(sessionId, shownKey));
    if (!shownKey) {
      return { ok: true, isSupported: false, platform: null, account: null, pending: pendingInfo };
    }
    const platform = platformOf(shownKey);
    const grant = platform ? await readGrant(platform) : null;
    return {
      ok: true,
      isSupported: true,
      platform: shownKey,
      authMode: platform ? (routeSnapshot(platform).value?.apiKeyEnv !== undefined ? "api-key" : "oauth") : null,
      account: platform ? publicAccount(grant, await displayFor(platform, grant)) : null,
      pending: pendingInfo,
    };
  }

  async function tick(attempt) {
    if (!isCurrent(attempt) || attempt.error || attempt.controller.signal.aborted) return;
    try {
      checkAttempt(attempt);
      const result =
        attempt.platform.id === "xai"
          ? await xaiPollOnce(attempt.deviceCode, attempt.controller.signal)
          : await openaiPollOnce(attempt.deviceAuthId, attempt.userCode, attempt.controller.signal);
      if (!isCurrent(attempt) || attempt.controller.signal.aborted) return;
      checkAttempt(attempt);
      if (result.slowDown) attempt.interval += 5;
      if (result.done) {
        await writeGrant(attempt, result.payload);
        if (isCurrent(attempt)) cancelPlatform(attempt.platformKey);
        return;
      }
      schedule(attempt, attempt.interval * 1000);
    } catch (error) {
      if (!isCurrent(attempt) || attempt.controller.signal.aborted) return;
      attempt.error = safeDetail(error?.message ?? "授权失败", [attempt.deviceCode, attempt.deviceAuthId]);
      stopTimer(attempt);
      clearDeadline(attempt);
    }
  }

  async function startLogin(platformKey, sessionId) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    const key = slotKey(platform);
    cancelPlatform(key);
    const attempt = {
      platformKey: key,
      platform,
      sessionId: sessionKey(sessionId),
      controller: new AbortController(),
      error: null,
      timer: null,
      deadlineTimer: null,
    };
    pendings.set(key, attempt);
    let started;
    try {
      await cancelOfficial(platform);
      attempt.controller.signal.throwIfAborted();
      started = platform.id === "xai"
        ? await xaiStart(attempt.controller.signal)
        : await openaiStart(attempt.controller.signal);
    } catch (error) {
      remember(attempt.deviceCode, attempt.deviceAuthId);
      if (isCurrent(attempt) && !attempt.controller.signal.aborted) {
        attempt.error = redact(error?.message ?? "申请设备码失败");
      }
      throw new Error(redact(error?.message ?? "申请设备码失败"));
    }
    attempt.controller.signal.throwIfAborted();
    Object.assign(attempt, {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      interval: started.interval || 5,
      deviceCode: started.deviceCode,
      deviceAuthId: started.deviceAuthId,
      expiresAt: started.expiresAt,
    });
    remember(attempt.deviceCode, attempt.deviceAuthId);
    if (!Number.isFinite(attempt.expiresAt)) {
      attempt.error = "设备码有效期无效，请重新登录";
      attempt.controller.abort();
      throw new Error(attempt.error);
    }
    if (!isCurrent(attempt)) return;
    armDeadline(attempt);
    schedule(attempt, attempt.interval * 1000);
  }

  async function logout(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    const key = slotKey(platform);
    let grant = null;
    try {
      grant = await readGrant(platform);
    } catch {
      throw new Error("退出失败，无法读取本地凭据");
    }
    const attempt = pendings.get(key);
    remember(grant?.access, grant?.refresh, attempt?.deviceCode, attempt?.deviceAuthId);
    cancelPlatform(key);
    await cancelOfficial(platform);
    lifetime.signal.throwIfAborted();
    // Settlement queues any already-accepted official result before deletion;
    // the shared credential queue also waits for a commit already in progress.
    try {
      await ctx.credentials.deleteRecord(platform.recordKey);
    } catch (error) {
      throw new Error(redact(error?.message ?? "退出失败，本地凭据未删除"));
    }
    delete profileCache[platform.id];
  }

  async function refresh(platformKey) {
    const platform = platformOf(platformKey);
    if (!platform) throw new Error("未知平台");
    const secrets = [];
    let updated;
    try {
      updated = await ctx.credentials.modifyRecord(platform.recordKey, async (current) => {
        lifetime.signal.throwIfAborted();
        const grant = grantFromRecord(current);
        if (!grant) throw new Error("未登录");
        secrets.push(grant.access, grant.refresh);
        remember(grant.access, grant.refresh);
        const payload = platform.id === "xai"
          ? await xaiRefresh(grant, lifetime.signal)
          : await openaiRefresh(grant, lifetime.signal);
        secrets.push(payload.access, payload.refresh);
        remember(payload.access, payload.refresh);
        return { kind: "grant", payload };
      });
    } catch (error) {
      throw new Error(safeDetail(error?.message ?? "刷新或凭据保存失败", secrets));
    }
    delete profileCache[platform.id];
    // A refresh may rotate the token. Persist it even if the models endpoint
    // is temporarily unavailable; retaining the old refresh token loses login.
    const grant = grantFromRecord(updated);
    remember(grant?.access, grant?.refresh);
    try {
      lifetime.signal.throwIfAborted();
      const ok = await verifyGrant(platform, grant, lifetime.signal);
      if (!ok) throw new Error("凭据已更新，但刷新后验证失败");
      await ensureRoute(platform);
    } catch (error) {
      throw new Error(safeDetail(error?.message ?? "刷新后验证失败", [grant?.access, grant?.refresh]));
    }
  }

  function cancelRequested(platformRaw, sessionId) {
    if (platformRaw) {
      const platform = platformOf(platformRaw);
      if (!platform) throw new Error("未知平台");
      cancelPlatform(slotKey(platform));
      return;
    }
    cancelSession(sessionId);
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
          await startLogin(body.platform, sid);
          return jsonResponse(200, await statusBody(sid));
        }
        if (action === "cancel") {
          cancelRequested(body.platform, sid);
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
        return fail(502, redact(error?.message ?? String(error)));
      }
    },
  });
}
