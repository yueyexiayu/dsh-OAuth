import { openaiRefresh, revokeGrant, verifyGrant, xaiRefresh } from './oauth.js';
import { API_PATH, GROK_USER_URL, USER_AGENT, XAI_USERINFO_URL, grantFromRecord, displayNameFromIdentity, platformOf, publicAccount, safeDetail, XAI_VERIFICATION_HOSTS } from './parse.js';
import { currentSelection, sameSelection, selectionConflict } from './selection.js';

export const name = 'OAuth';
export const inject = ['connection', 'credentials', 'authorization'];
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => jsonResponse(status, { ok: false, error });
const platformKeyForProvider = provider => provider === 'xai' ? 'grok' : provider === 'openai-codex' ? 'gpt' : null;
const slotKey = platform => platform.id === 'xai' ? 'grok' : 'gpt';
const sessionKey = id => String(id || '');

export function apply(ctx) {
  const pendings = new Map();
  const lifetime = new AbortController();
  const profileCache = Object.create(null);
  const seenSecrets = [];
  function remember(...values) { for (const value of values) if (typeof value === 'string' && value && !seenSecrets.includes(value)) seenSecrets.push(value); }
  const redact = value => safeDetail(value, seenSecrets);
  const isCurrent = attempt => pendings.get(attempt.platformKey) === attempt;
  function cancelPlatform(key) {
    const attempt = pendings.get(key);
    if (!attempt) return;
    attempt.controller.abort();
    attempt.ready();
    pendings.delete(key);
  }
  function cancelSession(id) { for (const [key, attempt] of pendings) if (attempt.sessionId === sessionKey(id)) cancelPlatform(key); }
  const unwatchModel = ctx.on?.('session/event', (session, event) => {
    // A late request/header may still name lastUsed while next is different.
    // UI model switches commit model/selection; only that intent cancels a flow.
    const provider = event?.type === 'model/selection' ? event.data.provider : undefined;
    if (provider === undefined) return;
    for (const [key, attempt] of pendings) if (attempt.sessionId === sessionKey(session.id) && attempt.platform.id !== provider) cancelPlatform(key);
  });
  ctx.effect(() => () => { lifetime.abort(); unwatchModel?.(); for (const key of [...pendings.keys()]) cancelPlatform(key); });

  async function cancelOfficial(platform) {
    const authorization = ctx.get('authorization');
    if (!authorization || typeof authorization.cancel !== 'function') throw new Error('官方 authorization 服务不可用，无法协调账号授权');
    lifetime.signal.throwIfAborted();
    const key = platform.recordKey;
    if (!authorization.describe?.(key)?.inFlight) { authorization.cancel(key); return; }
    let unwatch, abort;
    try {
      const settled = new Promise((resolve, reject) => {
        unwatch = ctx.on('authorization/settled', settledKey => { if (settledKey === key) resolve(); });
        abort = () => reject(lifetime.signal.reason);
        lifetime.signal.addEventListener('abort', abort, { once: true });
      });
      authorization.cancel(key);
      await settled;
    } finally { unwatch?.(); if (abort) lifetime.signal.removeEventListener('abort', abort); }
  }
  async function readGrant(platform) {
    const grant = grantFromRecord(await ctx.credentials.readRecord(platform.recordKey));
    remember(grant?.access, grant?.refresh); return grant;
  }
  function routeSnapshot(platform) {
    const settings = ctx.get('settings');
    const provider = ctx.get('llm')?.listConfigurableProviders().find(row => row.provider === platform.id);
    const ns = provider?.settingsNs ?? 'llm-pi-ai';
    const path = provider?.settingsPath ?? ['providers', platform.id];
    const descriptor = settings?.describe({ redactSecrets: true }).find(row => row.ns === ns);
    let value = descriptor?.value;
    for (const key of path) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
    return { settings, ns, path, descriptor, value };
  }
  async function ensureRoute(platform) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { settings, ns, path, descriptor, value } = routeSnapshot(platform);
      if (!settings) throw new Error('凭据已保存，但未加载 settings，无法补充模型路由');
      if (!descriptor) throw new Error(`凭据已保存，但模型路由配置 ${ns} 不可用`);
      if (value !== undefined) return;
      try { await settings.mutate(ns, [{ op: 'set', path, value: {} }], descriptor.revision); return; }
      catch (error) { if (error?.code !== 'SETTINGS_CONFLICT' || attempt === 2) throw new Error(`凭据已保存，但模型路由配置失败：${redact(error?.message ?? error)}`); }
    }
  }
  async function fetchGrokDisplay(grant) {
    const headers = { authorization: `Bearer ${grant.access}`, accept: 'application/json', 'user-agent': USER_AGENT, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-version': '0.1.0', 'x-grok-client-mode': 'headless' };
    const tryUrl = async url => {
      const response = await fetch(url, { headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)]) });
      return response.ok ? displayNameFromIdentity(await response.json()) : null;
    };
    for (const item of await Promise.allSettled([tryUrl(GROK_USER_URL), tryUrl(XAI_USERINFO_URL)])) if (item.status === 'fulfilled' && item.value) return item.value;
    return null;
  }
  async function displayFor(platform, grant) {
    if (!grant || platform.id !== 'xai') return null;
    const cached = profileCache[platform.id];
    if (cached && cached.access === grant.access && Date.now() - cached.at < (cached.name ? 300_000 : 30_000)) return cached.promise ?? cached.name;
    const entry = { access: grant.access, at: Date.now(), name: null };
    profileCache[platform.id] = entry;
    entry.promise = fetchGrokDisplay(grant).then(name => { entry.name = name; delete entry.promise; return name; });
    return entry.promise;
  }
  async function selection(id) { return currentSelection(ctx, id, lifetime.signal); }
  async function assertSelection(id, expected) { if (!sameSelection(await selection(id), expected)) throw selectionConflict(); lifetime.signal.throwIfAborted(); }
  async function statusBody(id, expectedProvider) {
    const picked = await selection(id);
    if (expectedProvider && picked.provider !== expectedProvider) throw selectionConflict();
    const key = platformKeyForProvider(picked.provider);
    if (!key) return { ok: true, isSupported: false, platform: null, account: null, pending: null };
    const platform = platformOf(key);
    const grant = await readGrant(platform);
    const account = publicAccount(grant, await displayFor(platform, grant));
    await assertSelection(id, picked);
    const attempt = pendings.get(key);
    const pending = attempt?.sessionId === sessionKey(id) ? { platform: key, label: platform.label, userCode: attempt.userCode || '', verificationUri: attempt.verificationUri || null, error: attempt.error || null } : null;
    return { ok: true, isSupported: true, platform: key, authMode: routeSnapshot(platform).value?.apiKeyEnv !== undefined ? 'api-key' : 'oauth', account, pending };
  }
  function noticeUrl(platform, raw) {
    const url = new URL(raw);
    const allowed = platform.id === 'xai' ? XAI_VERIFICATION_HOSTS : ['auth.openai.com'];
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.includes(url.hostname)) throw new Error('官方授权链接不受信任');
    url.searchParams.delete('device_code'); url.hash = ''; return url.href;
  }
  async function startLogin(platform, id, picked) {
    const key = slotKey(platform);
    cancelPlatform(key);
    let ready;
    const prepared = new Promise(resolve => { ready = resolve; });
    const attempt = { platformKey: key, platform, sessionId: sessionKey(id), controller: new AbortController(), ready, error: null };
    pendings.set(key, attempt);
    const authorization = ctx.get('authorization');
    try {
      await cancelOfficial(platform);
      await assertSelection(id, picked);
      attempt.controller.signal.throwIfAborted();
      if (typeof authorization.begin !== 'function' || !authorization.describe(platform.recordKey)?.methods.some(m => m.id === 'oauth')) throw new Error('官方 OAuth 授权流程不可用');
    } catch (error) {
      if (isCurrent(attempt)) attempt.error = redact(error.message ?? '官方授权准备失败');
      ready();
      throw error;
    }
    // The official flow owns device deadlines, polling, PKCE and credential commit.
    // This surface only translates notices and chooses the published device method.
    attempt.task = Promise.resolve().then(() => authorization.begin({
      key: platform.recordKey, method: 'oauth', signal: AbortSignal.any([lifetime.signal, attempt.controller.signal]),
      interaction: {
        notify(notice) {
          if (!isCurrent(attempt) || attempt.controller.signal.aborted || !notice.url) return;
          try { attempt.verificationUri = noticeUrl(platform, notice.url); attempt.userCode = typeof notice.code === 'string' ? notice.code : ''; }
          catch (error) { attempt.error = error.message; attempt.controller.abort(); }
          ready();
        },
        async prompt(prompt) {
          if (platform.id === 'openai-codex' && prompt.kind === 'select' && prompt.options?.some(option => option.id === 'device_code')) return 'device_code';
          throw new Error('设备登录出现不支持的官方交互');
        },
      },
    })).then(async outcome => {
      if (!isCurrent(attempt)) return;
      if (outcome.status === 'authorized') { delete profileCache[platform.id]; await ensureRoute(platform); cancelPlatform(key); }
      else if (!attempt.controller.signal.aborted) { attempt.error = '官方授权已取消，请重新登录'; }
    }).catch(() => {
      if (isCurrent(attempt) && !attempt.controller.signal.aborted) attempt.error = '官方 OAuth 授权或凭据保存失败，请重新登录';
    }).finally(ready);
    await prepared;
    if (attempt.error) throw new Error(attempt.error);
  }
  async function logout(platform, id, picked) {
    await assertSelection(id, picked);
    cancelPlatform(slotKey(platform));
    await cancelOfficial(platform);
    // An accepted official commit can replace the grant while cancellation
    // settles. Revoke the post-settlement credential, not a pre-wait snapshot.
    let grant;
    try { grant = await readGrant(platform); } catch { throw new Error('退出失败，无法读取本地凭据'); }
    await assertSelection(id, picked);
    let revokeFailure = '';
    if (grant) {
      try { const revoked = await revokeGrant(platform.id, grant, lifetime.signal); if (!revoked.ok) revokeFailure = revoked.message; }
      catch { lifetime.signal.throwIfAborted(); revokeFailure = '远端吊销失败，本地凭据已删除'; }
    }
    // Once remote revocation starts, finish deleting this same credential; never
    // leave a now-revoked grant behind because a model switch happened meanwhile.
    try { await ctx.credentials.deleteRecord(platform.recordKey); }
    catch (error) { throw new Error(redact(error?.message ?? '退出失败，本地凭据未删除')); }
    delete profileCache[platform.id];
    if (revokeFailure) throw new Error(revokeFailure);
  }
  async function refresh(platform, id, picked) {
    const secrets = [];
    let updated;
    try {
      updated = await ctx.credentials.modifyRecord(platform.recordKey, async current => {
        await assertSelection(id, picked);
        const grant = grantFromRecord(current);
        if (!grant) throw new Error('未登录');
        secrets.push(grant.access, grant.refresh); remember(grant.access, grant.refresh);
        const payload = platform.id === 'xai' ? await xaiRefresh(grant, lifetime.signal) : await openaiRefresh(grant, lifetime.signal);
        secrets.push(payload.access, payload.refresh); remember(payload.access, payload.refresh);
        return { kind: 'grant', payload };
      });
    } catch (error) { if (error?.status === 409) throw error; throw new Error(safeDetail(error?.message ?? '刷新或凭据保存失败', secrets)); }
    delete profileCache[platform.id];
    const grant = grantFromRecord(updated); remember(grant?.access, grant?.refresh);
    try {
      lifetime.signal.throwIfAborted();
      if (!await verifyGrant(platform, grant, lifetime.signal)) throw new Error('凭据已更新，但刷新后验证失败');
      await ensureRoute(platform);
    } catch (error) { throw new Error(safeDetail(error?.message ?? '刷新后验证失败', [grant?.access, grant?.refresh])); }
  }
  ctx.connection.fetch.register({ path: API_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (lifetime.signal.aborted) return fail(503, 'OAuth 插件已卸载');
      const url = new URL(request.url);
      const sessionId = url.searchParams.get('sessionId') ?? '';
      if (url.searchParams.has('sessionId') && !sessionId.trim()) return fail(400, 'invalid sessionId');
      if (request.method === 'GET') return jsonResponse(200, await statusBody(sessionId, url.searchParams.get('provider')));
      let body;
      try { body = JSON.parse(await request.text() || '{}'); } catch { return fail(400, 'invalid json'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid body');
      if (Object.hasOwn(body, 'sessionId') && (typeof body.sessionId !== 'string' || !body.sessionId.trim())) return fail(400, 'invalid sessionId');
      if (Object.hasOwn(body, 'provider') && (typeof body.provider !== 'string' || !body.provider.trim())) return fail(400, 'invalid provider');
      if (body.platform !== undefined && !platformOf(body.platform)) return fail(400, 'invalid platform');
      const id = body.sessionId ?? sessionId;
      if (!['start', 'cancel', 'logout', 'refresh'].includes(body.action)) return fail(400, 'unknown action');
      const picked = await selection(id);
      if (body.provider && body.provider !== picked.provider) throw selectionConflict();
      const shown = platformKeyForProvider(picked.provider);
      const platform = platformOf(body.platform ?? shown);
      if (!shown || !platform || slotKey(platform) !== shown) throw selectionConflict();
      if (body.action === 'start') await startLogin(platform, id, picked);
      if (body.action === 'cancel') {
        const attempt = pendings.get(shown);
        if (attempt && attempt.sessionId !== sessionKey(id)) throw selectionConflict();
        cancelSession(id);
      }
      if (body.action === 'logout') await logout(platform, id, picked);
      if (body.action === 'refresh') await refresh(platform, id, picked);
      return jsonResponse(200, await statusBody(id, body.provider));
    } catch (error) { return fail(error?.status ?? (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 404 : 502), redact(error?.message ?? String(error))); }
  } });
}
