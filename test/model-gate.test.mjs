import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const GPT_KEY = 'llm-pi-ai/openai-codex';
const GROK_KEY = 'llm-pi-ai/xai';
const grant = token => ({ kind: 'grant', payload: { type: 'oauth', access: token, refresh: token + '-refresh', expires: Date.now() + 60_000 } });

function mount(llm, credentialRecords, providers) {
  const disposers = [];
  apply({
    effect(callback) { disposers.push(callback()); },
    connection: { fetch: { register() {} } },
    credentials: { async readRecord(key) { return credentialRecords.get(key); } },
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'settings') return { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }] };
    },
  });
  return {
    llm,
    records: credentialRecords,
    dispose() { for (const disposer of disposers.reverse()) disposer?.(); },
  };
}

function host({ records = {}, providers = { 'openai-codex': {}, xai: {} } } = {}) {
  const models = {
    'openai-codex': [{ provider: 'openai-codex', id: 'codex-model', name: 'Codex model' }],
    xai: [{ provider: 'xai', id: 'grok-model', name: 'Grok model' }],
    custom: [{ provider: 'custom', id: 'custom-model', name: 'Custom model' }],
  };
  const llm = {
    async listModels(provider) { return models[provider] || []; },
    listConfigurableProviders() { return []; },
  };
  return mount(llm, new Map(Object.entries(records)), providers);
}

test('OAuth providers advertise no models without a saved grant', async () => {
  const h = host();
  assert.deepEqual(await h.llm.listModels('openai-codex'), []);
  assert.deepEqual(await h.llm.listModels('xai'), []);
  assert.deepEqual((await h.llm.listModels('custom')).map(model => model.id), ['custom-model']);
  h.dispose();
});

test('saved grants restore the original model catalog and API-key routes stay visible', async () => {
  const h = host({ records: { [GPT_KEY]: grant('gpt'), [GROK_KEY]: grant('grok') } });
  assert.deepEqual((await h.llm.listModels('openai-codex')).map(model => model.id), ['codex-model']);
  assert.deepEqual((await h.llm.listModels('xai')).map(model => model.id), ['grok-model']);
  h.records.delete(GPT_KEY);
  assert.deepEqual(await h.llm.listModels('openai-codex'), []);
  h.dispose();

  const keyed = host({ providers: { 'openai-codex': { apiKeyEnv: 'SYNTHETIC_KEY' }, xai: {} } });
  assert.deepEqual((await keyed.llm.listModels('openai-codex')).map(model => model.id), ['codex-model']);
  assert.deepEqual(await keyed.llm.listModels('xai'), []);
  keyed.dispose();
});

test('disposing the plugin restores the original listModels method', async () => {
  const h = host();
  const gated = h.llm.listModels;
  h.dispose();
  assert.notEqual(h.llm.listModels, gated);
  assert.deepEqual((await h.llm.listModels('openai-codex')).map(model => model.id), ['codex-model']);
});

for (const disposeOrder of [['old', 'new'], ['new', 'old']]) {
  test('overlapping plugin lifecycles keep the gate until the last instance: ' + disposeOrder.join(' then '), async () => {
    const providers = { 'openai-codex': {}, xai: {} };
    const discovery = host({ providers });
    const overlap = mount(discovery.llm, discovery.records, providers);
    const instances = { old: discovery, new: overlap };
    instances[disposeOrder[0]].dispose();
    assert.deepEqual(await overlap.llm.listModels('openai-codex'), []);
    instances[disposeOrder[1]].dispose();
    assert.deepEqual((await discovery.llm.listModels('openai-codex')).map(model => model.id), ['codex-model']);
  });
}
