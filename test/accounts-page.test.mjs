import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const payload = {
  ok: true,
  isSupported: true,
  accounts: [
    { id: 'gpt', label: 'Codex', accounts: [{ id: 'a'.repeat(24), label: 'first@example.invalid', active: true, expired: false }], pending: null },
    { id: 'grok', label: 'Grok', accounts: [], pending: null },
  ],
};
const response = body => ({ ok: true, status: 200, async json() { return body; } });
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function pageHarness() {
  const hooks = [];
  const effects = [];
  const requests = [];
  const timers = [];
  const registrations = {};
  let registration;
  let cursor = 0;
  let component;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      hooks[index] ??= { current: initial };
      return hooks[index];
    },
    useEffect(callback) { effects.push(callback); },
  };
  vm.runInNewContext(source, {
    document: { getElementById: () => ({}), head: {} },
    window: { __ModuleLoader__: { load({ factory }) { registration = factory(() => React); } } },
    AbortSignal, AbortController,
    setInterval(callback) { timers.push(callback); return timers.length; },
    clearInterval() {},
    fetch(url, init) { return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })); },
  });
  registration.apply({ slots: {
    inject(name, callback) { if (name === 'plugins.bundle.config') callback(); },
    register(options, render) { registrations[options.name] = render; },
  } });
  component = registrations['plugins.bundle.config'];
  function nodes(node) {
    if (node == null || typeof node === 'boolean') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (typeof node !== 'object') return [node];
    if (typeof node.type === 'function') return nodes(node.type(node.props));
    return [node, ...node.children.flatMap(nodes)];
  }
  function render() {
    cursor = 0;
    return component({ view: 'page' });
  }
  function flushEffects() { while (effects.length) effects.shift()(); }
  render();
  flushEffects();
  return {
    requests,
    render,
    text() { return nodes(render()).filter(node => typeof node === 'string').join(' '); },
    tick() { for (const callback of timers) callback(); },
    button(label, attribute = 'aria-label') {
      return nodes(render()).find(node => node.type === 'button' && (node.props[attribute] === label || node.children.includes(label)));
    },
  };
}

test('plugin page renders both supported platforms and saved account labels', async () => {
  const page = pageHarness();
  page.requests[0].resolve(response(payload));
  await settle();
  const text = page.text();
  assert.match(text, /Codex/);
  assert.match(text, /Grok/);
  assert.match(text, /first@example\.invalid/);
  assert.match(text, /添加账号/);
  assert.match(text, /登录 Grok/);
  assert.match(text, /当前账号/);
});

test('add and delete controls submit account actions through the host API', async () => {
  const page = pageHarness();
  page.requests[0].resolve(response(payload));
  await settle();
  page.button('添加 Codex 账号').props.onClick();
  const add = page.requests.at(-1);
  assert.match(String(add.url), /\?view=accounts$/);
  assert.deepEqual(JSON.parse(add.init.body), { action: 'account-add', platform: 'gpt' });
  add.resolve(response(payload));
  await settle();
  page.button('删除 first@example.invalid').props.onClick();
  assert.ok(page.button('确认删除'));
  page.button('确认删除').props.onClick();
  const remove = page.requests.at(-1);
  assert.deepEqual(JSON.parse(remove.init.body), { action: 'account-delete', platform: 'gpt', accountId: 'a'.repeat(24) });
});

test('pending device authorization shows the trusted link and code with a cancel action', async () => {
  const page = pageHarness();
  const pending = structuredClone(payload);
  pending.accounts[1].pending = { platform: 'grok', label: 'Grok', userCode: 'LOGIN-CODE', verificationUri: 'https://accounts.x.ai/device', error: null };
  page.requests[0].resolve(response(pending));
  await settle();
  const text = page.text();
  assert.match(text, /LOGIN-CODE/);
  assert.match(text, /Grok 授权页/);
  page.button('取消登录').props.onClick();
  assert.deepEqual(JSON.parse(page.requests.at(-1).init.body), { action: 'account-cancel', platform: 'grok' });
});

test('actions pause polling and stale list replies cannot overwrite their result', async () => {
  const page = pageHarness();
  page.requests[0].resolve(response(payload));
  await settle();
  page.tick();
  const stale = page.requests.at(-1);
  const changed = structuredClone(payload);
  changed.accounts[0].accounts = [];
  page.button('添加 Codex 账号').props.onClick();
  const action = page.requests.at(-1);
  const countWhileBusy = page.requests.length;
  page.tick();
  assert.equal(page.requests.length, countWhileBusy);
  action.resolve(response(changed));
  await settle();
  stale.resolve(response(payload));
  await settle();
  const text = page.text();
  assert.match(text, /尚未登录/);
  assert.doesNotMatch(text, /first@example\.invalid/);
});

test('a successful poll does not clear an action error', async () => {
  const page = pageHarness();
  page.requests[0].resolve(response(payload));
  await settle();
  page.button('删除 first@example.invalid').props.onClick();
  page.button('确认删除').props.onClick();
  page.requests.at(-1).reject(new Error('delete-fixture-failed'));
  await settle();
  assert.match(page.text(), /delete-fixture-failed/);
  page.tick();
  page.requests.at(-1).resolve(response(payload));
  await settle();
  assert.match(page.text(), /delete-fixture-failed/);
});
