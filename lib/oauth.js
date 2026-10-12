import { OPENAI_CLIENT_ID, OPENAI_MODELS_URL, OPENAI_REVOKE_URL, OPENAI_TOKEN_URL, USER_AGENT, XAI_CLIENT_ID, XAI_MODELS_URL, XAI_REFRESH_SKEW_MS, XAI_REVOKE_URL, XAI_TOKEN_URL, accountIdFromJwt } from './parse.js';

const FETCH_MS = 30_000;
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
function requireString(value, field) { if (!nonEmptyString(value)) throw new Error(`OAuth 响应缺少有效 ${field}`); return value; }
function expiresAt(seconds, skew = 0) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw new Error('OAuth 响应包含无效 expires_in');
  const expires = Date.now() + seconds * 1000 - skew;
  if (!Number.isFinite(expires) || expires <= 0 || expires > 8.64e15) throw new Error('OAuth 响应包含无效 expires_in');
  return expires;
}
function xaiPayload(body, previousRefresh) {
  return { type: 'oauth', access: requireString(body.access_token, 'access_token'), refresh: requireString(body.refresh_token === undefined ? previousRefresh : body.refresh_token, 'refresh_token'), expires: expiresAt(body.expires_in === undefined ? 3600 : body.expires_in, XAI_REFRESH_SKEW_MS) };
}
function openaiPayload(body, previousAccountId) {
  const access = requireString(body.access_token, 'access_token');
  return { type: 'oauth', access, refresh: requireString(body.refresh_token, 'refresh_token'), expires: expiresAt(body.expires_in), accountId: requireString(accountIdFromJwt(access) || previousAccountId, 'chatgpt_account_id') };
}
export async function requestJson(url, options = {}) {
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT, ...(options.headers || {}) };
  let body;
  if (options.form) { body = new URLSearchParams(options.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  let response;
  try { response = await fetch(url, { method: options.method || 'GET', headers, body, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_MS)]) : AbortSignal.timeout(FETCH_MS) }); }
  catch (error) { options.signal?.throwIfAborted(); return { ok: false, status: 0, body: error?.message ?? 'network error' }; }
  let parsed;
  try { parsed = await response.json(); }
  catch { options.signal?.throwIfAborted(); return { ok: false, status: response.status, body: null, error: 'invalid JSON response' }; }
  return { ok: response.ok, status: response.status, body: parsed };
}
export async function xaiRefresh(grant, signal) {
  requireString(grant?.refresh, 'refresh_token');
  const res = await requestJson(XAI_TOKEN_URL, { method: 'POST', signal, form: { grant_type: 'refresh_token', client_id: XAI_CLIENT_ID, refresh_token: grant.refresh } });
  if (!res.ok || !res.body) throw new Error(`xAI 刷新失败 (HTTP ${res.status})`);
  return xaiPayload(res.body, grant.refresh);
}
export async function openaiRefresh(grant, signal) {
  requireString(grant?.refresh, 'refresh_token');
  const res = await requestJson(OPENAI_TOKEN_URL, { method: 'POST', signal, form: { grant_type: 'refresh_token', client_id: OPENAI_CLIENT_ID, refresh_token: grant.refresh } });
  if (!res.ok || !res.body) throw new Error(`OpenAI Codex 刷新失败 (HTTP ${res.status})`);
  return openaiPayload(res.body, grant.accountId);
}
export async function verifyGrant(platform, grant, signal) {
  if (!nonEmptyString(grant?.access)) return false;
  const headers = { authorization: `Bearer ${grant.access}` };
  if (platform.id === 'xai') {
    const res = await requestJson(XAI_MODELS_URL, { headers, signal });
    return Boolean(res.ok && res.body && Array.isArray(res.body.data));
  }
  if (!nonEmptyString(grant.accountId)) return false;
  const res = await requestJson(OPENAI_MODELS_URL, { signal, headers: { ...headers, 'ChatGPT-Account-Id': grant.accountId } });
  return Boolean(res.ok && res.body && Array.isArray(res.body.models) && res.body.models.every(model => model && nonEmptyString(model.slug)));
}
export async function revokeGrant(platformId, grant, signal) {
  const refresh = nonEmptyString(grant?.refresh) ? grant.refresh : '';
  const access = nonEmptyString(grant?.access) ? grant.access : '';
  const token = refresh || access;
  if (!token) return { ok: true, skipped: true };
  const res = await requestJson(platformId === 'xai' ? XAI_REVOKE_URL : OPENAI_REVOKE_URL, { method: 'POST', signal, form: { token, token_type_hint: refresh ? 'refresh_token' : 'access_token', client_id: platformId === 'xai' ? XAI_CLIENT_ID : OPENAI_CLIENT_ID } });
  if (res.ok || res.status === 200 || res.status === 204) return { ok: true };
  const error = res.body && typeof res.body === 'object' ? res.body.error : '';
  if (res.status === 400 && error === 'invalid_token') return { ok: true };
  const status = Number.isInteger(res.status) ? res.status : 0;
  return { ok: false, message: status > 0 ? `远端吊销失败 (HTTP ${status})，本地凭据已删除` : '远端吊销失败，本地凭据已删除' };
}
