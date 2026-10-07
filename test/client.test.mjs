import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const snapshot = (extra = {}) => ({ ok: true, isSupported: true, platform: "gpt", account: { loggedIn: true, account: "current-account" }, pending: null, ...extra });
const response = (body = snapshot(), status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

// Runs the actual client component with controlled effects, timers and requests.
// No credentials, configuration or network endpoints are accessed.
function harness(sessionId = "session-a") {
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const requests = [];
  let cursor = 0;
  let timerId = 0;
  let registration;
  let component;
  let tree;
  let unmounted = false;
  let updatesAfterUnmount = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, (next) => {
        if (unmounted) updatesAfterUnmount++;
        hooks[index].value = typeof next === "function" ? next(hooks[index].value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      hooks[index] ??= { current: initial };
      return hooks[index];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: callback() };
        });
      }
    },
  };
  const context = {
    document: { getElementById: () => ({}), head: {} },
    window: { __ModuleLoader__: { load({ factory }) { registration = factory(() => React); } } },
    setInterval(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    fetch(url, init) {
      return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
    },
  };
  vm.runInNewContext(source, context);
  registration.apply({ slots: {
    inject(_name, callback) { callback(); },
    register(_options, render) { component = render({ sessionId }).type; },
  } });
  function render() {
    cursor = 0;
    tree = component({ sessionId });
    return tree;
  }
  function nodes(node = render()) {
    if (node == null || typeof node === "boolean") return [];
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
    if (typeof node !== "object") return [node];
    if (typeof node.type === "function") return nodes(node.type(node.props));
    return [node, ...node.children.flatMap((child) => nodes(child))];
  }
  function flushEffects() { while (effects.length) effects.shift()(); }
  render();
  flushEffects();
  return {
    requests,
    render,
    text() { return nodes().filter((node) => typeof node === "string").join(" "); },
    click(label) {
      const button = nodes().find((node) => node.type === "button" && node.children.includes(label));
      assert.ok(button, `missing button ${label}`);
      assert.notEqual(button.props.disabled, true, `${label} must be enabled`);
      button.props.onClick();
    },
    tick() { for (const callback of timers.values()) callback(); },
    switchSession(next, flush = true) { sessionId = next; render(); if (flush) flushEffects(); },
    unmount() { unmounted = true; for (const hook of hooks) hook?.cleanup?.(); },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
  };
}

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function loaded(extra) {
  const h = harness();
  h.requests[0].resolve(response(snapshot(extra)));
  await settle();
  return h;
}

for (const operation of ["query", "action"]) {
  for (const kind of ["network", "http", "json", "business"]) {
    test(`${operation} ${kind} failure is visible and clears busy`, async () => {
      const h = operation === "query" ? harness() : await loaded();
      if (operation === "action") h.click("退出");
      const request = h.requests.at(-1);
      if (kind === "network") request.reject(new Error("offline-fixture"));
      if (kind === "http") request.resolve(response({ ok: true }, 503));
      if (kind === "json") request.resolve({ ok: true, status: 200, async json() { throw new SyntaxError("malformed fixture"); } });
      if (kind === "business") request.resolve(response({ ok: false, error: "business-fixture" }));
      await settle();
      assert.match(h.text(), { network: /offline-fixture/, http: /HTTP 503/, json: /JSON/, business: /business-fixture/ }[kind]);
      if (operation === "action") h.click("退出");
    });
  }
}

test("successful polling cannot erase an action error", async () => {
  const h = await loaded();
  h.click("退出");
  h.requests.at(-1).resolve(response({ ok: false, error: "logout-fixture-failed" }, 502));
  await settle();
  h.tick();
  h.requests.at(-1).resolve(response());
  await settle();
  assert.match(h.text(), /logout-fixture-failed/);
  h.click("退出");
  h.requests.at(-1).resolve(response(snapshot({ account: { loggedIn: false } })));
  await settle();
  assert.doesNotMatch(h.text(), /logout-fixture-failed/);
});

test("a successful query clears only the previous query failure", async () => {
  const h = harness();
  h.requests[0].reject(new Error("query-fixture-failed"));
  await settle();
  assert.match(h.text(), /query-fixture-failed/);
  h.tick();
  h.requests.at(-1).resolve(response());
  await settle();
  assert.doesNotMatch(h.text(), /query-fixture-failed/);
  assert.match(h.text(), /current-account/);
});

test("a GET started before logout cannot overwrite its POST result", async () => {
  const h = await loaded();
  h.tick();
  const stale = h.requests.at(-1);
  h.click("退出");
  h.requests.at(-1).resolve(response(snapshot({ account: { loggedIn: false } })));
  await settle();
  stale.resolve(response());
  await settle();
  assert.match(h.text(), /未登录/);
  assert.doesNotMatch(h.text(), /current-account/);
});

test("polling is paused during a mutation and old GET failures cannot override it", async () => {
  const h = await loaded();
  h.tick();
  const stale = h.requests.at(-1);
  h.click("退出");
  const count = h.requests.length;
  h.tick();
  assert.equal(h.requests.length, count);
  h.requests.at(-1).resolve(response(snapshot({ account: { loggedIn: false } })));
  stale.reject(new Error("old-query-error"));
  await settle();
  assert.match(h.text(), /未登录/);
  assert.doesNotMatch(h.text(), /old-query-error/);
});

test("out-of-order GET replies cannot revert newer account state", async () => {
  const h = await loaded();
  h.tick();
  const older = h.requests.at(-1);
  h.tick();
  h.requests.at(-1).resolve(response(snapshot({ account: { loggedIn: false } })));
  await settle();
  older.resolve(response());
  await settle();
  assert.match(h.text(), /未登录/);
});

for (const kind of ["success", "error"]) {
  test(`session switching ignores stale action ${kind} and clears old account immediately`, async () => {
    const h = await loaded();
    h.click("退出");
    const stale = h.requests.at(-1);
    h.switchSession("session-b", false);
    assert.doesNotMatch(h.text(), /current-account/);
    if (kind === "success") stale.resolve(response(snapshot({ account: { loggedIn: true, account: "stale-account" } })));
    else stale.reject(new Error("stale-action-error"));
    await settle();
    assert.doesNotMatch(h.text(), /stale-account|stale-action-error/);
    h.switchSession("session-b");
    const current = h.requests.at(-1);
    assert.match(current.url, /sessionId=session-b/);
    current.resolve(response(snapshot({ account: { loggedIn: true, account: "session-b-account" } })));
    await settle();
    assert.match(h.text(), /session-b-account/);
  });
  test(`unmount ignores pending action ${kind} without a state update`, async () => {
    const h = await loaded();
    h.click("退出");
    const stale = h.requests.at(-1);
    h.unmount();
    if (kind === "success") stale.resolve(response());
    else stale.reject(new Error("disposed-fixture"));
    await settle();
    assert.equal(h.updatesAfterUnmount, 0);
  });
}

test("session switch and unmount also invalidate pending GET responses", async () => {
  const h = harness();
  const old = h.requests[0];
  h.switchSession("session-b");
  old.resolve(response(snapshot({ account: { loggedIn: true, account: "old-get-account" } })));
  await settle();
  assert.doesNotMatch(h.text(), /old-get-account/);
  h.unmount();
  h.requests.at(-1).reject(new Error("old-get-after-unmount"));
  await settle();
  assert.equal(h.updatesAfterUnmount, 0);
});

test("API key models explicitly distinguish model authentication from OAuth account controls", async () => {
  const h = await loaded({ authMode: "api-key" });
  assert.match(h.text(), /模型使用 API key/);
  assert.match(h.text(), /退出 OAuth 不影响/);
  assert.match(h.text(), /换号/);
  h.click("退出");
  h.requests.at(-1).resolve(response(snapshot({ authMode: "api-key", account: { loggedIn: false } })));
  await settle();
  assert.match(h.text(), /模型使用 API key/);
  assert.match(h.text(), /未登录/);
  h.click("登录");
  assert.equal(JSON.parse(h.requests.at(-1).init.body).action, "start");
});

test("malformed JSON payload shapes are visible rather than an empty successful state", async () => {
  for (const body of [null, [], {}, { ok: true }, { ok: "true", isSupported: true }]) {
    const h = harness();
    h.requests[0].resolve(response(body));
    await settle();
    assert.match(h.text(), /JSON/);
  }
});

test("non-JSON HTTP failures preserve both HTTP status and parsing failure", async () => {
  const h = harness();
  h.requests[0].resolve({ ok: false, status: 502, async json() { throw new SyntaxError("html fixture"); } });
  await settle();
  assert.match(h.text(), /HTTP 502/);
  assert.match(h.text(), /JSON/);
});

test("failed cancellation keeps the authorization and error visible across polls", async () => {
  const pending = { verificationUri: "https://example.invalid/fixture", label: "GPT", userCode: "TEST-CODE" };
  const h = await loaded({ pending });
  h.click("取消");
  h.requests.at(-1).resolve(response({ ok: false, error: "cancel-fixture-failed" }, 502));
  await settle();
  h.tick();
  h.requests.at(-1).resolve(response(snapshot({ pending })));
  await settle();
  assert.match(h.text(), /cancel-fixture-failed/);
  assert.match(h.text(), /TEST-CODE/);
  h.click("取消");
  h.requests.at(-1).resolve(response());
  await settle();
  assert.doesNotMatch(h.text(), /cancel-fixture-failed|TEST-CODE/);
});

test("API key Grok model retains OAuth refresh control and authentication notice", async () => {
  const h = await loaded({ platform: "grok", authMode: "api-key", account: { loggedIn: true, expired: true } });
  assert.match(h.text(), /Grok OAuth/);
  assert.match(h.text(), /模型使用 API key/);
  h.click("刷新");
  assert.deepEqual(JSON.parse(h.requests.at(-1).init.body), { action: "refresh", platform: "grok", sessionId: "session-a" });
});

test("unsupported models remain hidden when no operation or query has failed", async () => {
  const h = await loaded({ isSupported: false, platform: null });
  assert.equal(h.render(), null);
});
