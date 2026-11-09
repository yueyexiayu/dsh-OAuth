import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { apply } from '../lib/index.js';

const GPT_KEY = 'llm-pi-ai/openai-codex';
const GROK_KEY = 'llm-pi-ai/xai';
const flush = () => new Promise(setImmediate);

function jwt(accountId, email) {
  return 'aaa.' + Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email },
  })).toString('base64url') + '.sig';
}

function grant(accountId, email, token) {
  return {
    kind: 'grant',
    payload: { type: 'oauth', access: jwt(accountId, email), refresh: token + '-refresh', accountId, expires: Date.now() + 60_000 },
  };
}

function memoryCredentials(initial = {}) {
  const records = new Map(Object.entries(initial));
  let beforeModify = null;
  return {
    records,
    modifyCount: 0,
    setBeforeModify(callback) { beforeModify = callback; },
    async readRecord(key) { return records.get(key); },
    async listRecords() { return [...records].map(([key, record]) => ({ key, kind: record.kind })); },
    async modifyRecord(key, mutate) {
      this.modifyCount++;
      beforeModify?.(key, records);
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return next;
    },
    async deleteRecord(key) { records.delete(key); },
  };
}

function host(t, { records, begin, cancel } = {}) {
  let route;
  let dispose;
  const credentials = memoryCredentials(records);
  const authorization = {
    describe(key) { return { methods: [{ id: 'oauth' }], inFlight: false, key }; },
    cancel(key) { cancel?.(key, credentials.records); },
    begin: begin ?? (async request => {
      const access = jwt('account-b', 'second@example.invalid');
      await credentials.modifyRecord(request.key, async () => ({ kind: 'grant', payload: { type: 'oauth', access, refresh: 'second-refresh', accountId: 'account-b', expires: Date.now() + 60_000 } }));
      request.interaction.notify({ url: 'https://auth.openai.com/codex/device', code: 'SECOND' });
      return { status: 'authorized' };
    }),
  };
  apply({
    effect(callback) { dispose = callback(); },
    on() { return () => {}; },
    connection: { fetch: { register(value) { route = value; } } },
    credentials,
    get(name) {
      if (name === 'authorization') return authorization;
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { 'openai-codex': {}, xai: {} } } }] };
    },
  });
  t.after(() => dispose());
  return {
    credentials,
    async get() {
      const response = await route.fetch(new Request('http://fixture.invalid/api/OAuth?view=accounts'));
      return response.json();
    },
    async post(body) {
      const response = await route.fetch(new Request('http://fixture.invalid/api/OAuth?view=accounts', { method: 'POST', body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('accounts page lists only Codex and Grok and marks the current account', async t => {
  const h = host(t, { records: { [GPT_KEY]: grant('account-a', 'first@example.invalid', 'first') } });
  const body = await h.get();
  assert.deepEqual(body.accounts.map(platform => platform.label), ['Codex', 'Grok']);
  assert.equal(body.accounts[0].accounts.length, 1);
  assert.equal(body.accounts[0].accounts[0].label, 'first@example.invalid');
  assert.equal(body.accounts[0].accounts[0].active, true);
  assert.equal(body.accounts[1].accounts.length, 0);
  assert.equal(JSON.stringify(body).includes('first-refresh'), false);
  assert.equal(h.credentials.records.size, 1);
});

test('adding an account archives the previous credential before official login replaces it', async t => {
  const first = grant('account-a', 'first@example.invalid', 'first');
  const h = host(t, { records: { [GPT_KEY]: first } });
  const before = await h.get();
  const oldId = before.accounts[0].accounts[0].id;
  const added = await h.post({ action: 'account-add', platform: 'gpt' });
  assert.equal(added.status, 200);
  await flush();
  const after = await h.get();
  assert.equal(after.accounts[0].accounts.length, 2);
  assert.equal(after.accounts[0].accounts.find(account => account.id === oldId).label, 'first@example.invalid');
  assert.equal(after.accounts[0].accounts.find(account => account.active).label, 'second@example.invalid');
  assert.equal(h.credentials.records.get(GPT_KEY).payload.accountId, 'account-b');
});

test('switching a saved account writes it back to the official credential key', async t => {
  const h = host(t, { records: { [GPT_KEY]: grant('account-b', 'second@example.invalid', 'second') } });
  const archiveKey = 'oauth-accounts/gpt-' + 'a'.repeat(24);
  h.credentials.records.set(archiveKey, grant('account-a', 'first@example.invalid', 'first'));
  const before = await h.get();
  const oldId = before.accounts[0].accounts.find(account => !account.active).id;
  const switched = await h.post({ action: 'account-switch', platform: 'gpt', accountId: oldId });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.accounts[0].accounts.find(account => account.active).id, oldId);
  assert.equal(h.credentials.records.get(GPT_KEY).payload.accountId, 'account-a');
  assert.equal(h.credentials.records.get(GPT_KEY).payload.access, grant('account-a', 'first@example.invalid', 'first').payload.access);
});

test('deleting an inactive account revokes it and leaves the active credential intact', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const h = host(t, { records: { [GPT_KEY]: grant('account-b', 'second@example.invalid', 'second') } });
  const archiveKey = 'oauth-accounts/gpt-' + 'a'.repeat(24);
  h.credentials.records.set(archiveKey, grant('account-a', 'first@example.invalid', 'first'));
  const before = await h.get();
  const oldId = before.accounts[0].accounts.find(account => !account.active).id;
  const deleted = await h.post({ action: 'account-delete', platform: 'gpt', accountId: oldId });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.accounts[0].accounts.length, 1);
  assert.equal(deleted.body.accounts[0].accounts[0].active, true);
  assert.equal(h.credentials.records.has(archiveKey), false);
  assert.equal(h.credentials.records.get(GPT_KEY).payload.accountId, 'account-b');
});

test('deleting the active account revokes the credential committed during cancellation', async t => {
  const first = grant('account-b', 'second@example.invalid', 'second');
  let revoked;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    revoked = new URLSearchParams(options.body).get('token');
    return new Response(null, { status: 200 });
  });
  const h = host(t, {
    records: { [GPT_KEY]: first },
    cancel(_key, records) {
      const latest = grant('account-b', 'second@example.invalid', 'second-rotated');
      records.set(GPT_KEY, latest);
    },
  });
  const before = await h.get();
  const activeId = before.accounts[0].accounts[0].id;
  const deleted = await h.post({ action: 'account-delete', platform: 'gpt', accountId: activeId });
  assert.equal(deleted.status, 200);
  assert.equal(revoked, 'second-rotated-refresh');
  assert.equal(h.credentials.records.has(GPT_KEY), false);
});

test('listing an unchanged active account does not rewrite its archive', async t => {
  const active = grant('account-b', 'second@example.invalid', 'second');
  const accountKey = 'account-b';
  const archiveKey = 'oauth-accounts/gpt-' + createHash('sha256').update(accountKey).digest('hex').slice(0, 24);
  const archived = structuredClone(active);
  archived.payload.accountKey = accountKey;
  archived.payload.label = 'second@example.invalid';
  archived.payload.addedAt = 1;
  const h = host(t, { records: { [GPT_KEY]: active, [archiveKey]: archived } });
  await h.get();
  await h.get();
  assert.equal(h.credentials.modifyCount, 0);
});

test('switching retries when the official credential refreshes before the replacement write', async t => {
  const h = host(t, { records: { [GPT_KEY]: grant('account-b', 'second@example.invalid', 'second') } });
  const archiveKey = 'oauth-accounts/gpt-' + 'a'.repeat(24);
  const first = grant('account-a', 'first@example.invalid', 'first');
  h.credentials.records.set(archiveKey, first);
  const before = await h.get();
  const oldId = before.accounts[0].accounts.find(account => !account.active).id;
  let raced = false;
  h.credentials.setBeforeModify((key, records) => {
    if (key !== GPT_KEY || raced) return;
    raced = true;
    records.set(GPT_KEY, grant('account-b', 'second@example.invalid', 'second-rotated'));
  });
  const switched = await h.post({ action: 'account-switch', platform: 'gpt', accountId: oldId });
  assert.equal(switched.status, 200);
  assert.equal(h.credentials.records.get(GPT_KEY).payload.accountId, 'account-a');
  const archived = [...h.credentials.records.values()].find(record => record.payload?.refresh === 'second-rotated-refresh');
  assert.ok(archived, 'the refreshed active account must be archived before switching');
});

test('unknown providers and malformed account ids are rejected without touching credentials', async t => {
  const h = host(t, { records: { [GROK_KEY]: { kind: 'grant', payload: { type: 'oauth', access: 'opaque', refresh: 'refresh', expires: Date.now() + 60_000 } } } });
  const invalidPlatform = await h.post({ action: 'account-add', platform: 'deepseek' });
  assert.equal(invalidPlatform.status, 400);
  const invalidId = await h.post({ action: 'account-switch', platform: 'gpt', accountId: '../escape' });
  assert.equal(invalidId.status, 400);
  assert.equal(h.credentials.records.get(GROK_KEY).payload.access, 'opaque');
});
