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
  pickDisplayName,
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
    for (const url of [GROK_USER_URL, XAI_USERINFO_URL]) {
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const body = await response.json();
        const user = body && typeof body.user === "object" ? body.user : null;
        const name = pickDisplayName(
          body && body.email,
          user && user.email,
          body && body.name,
          user && user.name,
          body && body.username,
          body && body.userName,
          body && body.handle,
          body && body.preferred_username,
        );
        if (name) return name;
      } catch {
        // try next identity endpoint
      }
    }
    return null;
  }

  async function displayFor(platform, grant) {
    if (!grant) return null;
    const cached = profileCache[platform.id];
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.name;
    let name = null;
    if (platform.id === "xai") name = await fetchGrokDisplay(grant);
    profileCache[platform.id] = { at: Date.now(), name };
    return name;
  }

  async function statusBody() {
    const grok = platformOf("grok");
    const gpt = platformOf("gpt");
    const grokGrant = await readGrant(grok);
    const gptGrant = await readGrant(gpt);
    return {
      ok: true,
      grok: publicAccount(grokGrant, await displayFor(grok, grokGrant)),
      gpt: publicAccount(gptGrant, await displayFor(gpt, gptGrant)),
      pending: publicPending(pending),
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
        if (request.method === "GET") return jsonResponse(200, await statusBody());
        const raw = await request.text();
        let body = {};
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return fail(400, "invalid json");
          }
        }
        const action = body.action;
        if (action === "start") {
          await startLogin(body.platform);
          return jsonResponse(200, await statusBody());
        }
        if (action === "cancel") {
          stopTimer();
          pending = null;
          return jsonResponse(200, await statusBody());
        }
        if (action === "logout") {
          await logout(body.platform);
          return jsonResponse(200, await statusBody());
        }
        if (action === "refresh") {
          await refresh(body.platform);
          return jsonResponse(200, await statusBody());
        }
        return fail(400, "unknown action");
      } catch (error) {
        return fail(502, error && error.message ? error.message : String(error));
      }
    },
  });
}
