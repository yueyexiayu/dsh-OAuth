window.__ModuleLoader__.load({
  id: "OAuth",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];
    var STYLE_ID = "oauth-style";
    var API_PATH = "/api/OAuth";

    var cssText =
      ".oauth-bar { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; line-height: 1.5; " +
      "font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif); " +
      "color: var(--dsw-alias-label-secondary); white-space: nowrap; user-select: none; } " +
      ".oauth-item { display: inline-flex; align-items: center; gap: 4px; } " +
      ".oauth-on { color: var(--dsw-alias-state-success-primary); font-weight: 600; } " +
      ".oauth-off { color: var(--dsw-alias-label-secondary); } " +
      ".oauth-err { color: var(--dsw-alias-state-error-primary); } " +
      ".oauth-btn { border: 0; background: transparent; color: var(--dsw-alias-label-primary); " +
      "font-family: inherit; cursor: pointer; font-size: 12px; padding: 0 2px; } " +
      ".oauth-btn:hover { text-decoration: underline; } " +
      ".oauth-btn:disabled, .oauth-btn:disabled:hover { opacity: 0.45; cursor: default; text-decoration: none; } " +
      ".oauth-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #007aff); outline-offset: 2px; } " +
      ".oauth-code { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-label-primary); }";

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function requestSignal(existing) {
      var timeout = AbortSignal.timeout(20000);
      return existing ? AbortSignal.any([existing, timeout]) : timeout;
    }

    function requestFailure(error) {
      var name = error && error.name;
      if (name === "TimeoutError" || name === "AbortError") return "OAuth 请求超时";
      return "OAuth 网络请求失败：" + (error && error.message ? error.message : "无法连接");
    }

    async function request(url, options) {
      var response;
      var init = Object.assign({}, options, { signal: requestSignal(options && options.signal) });
      try {
        response = await fetch(url, init);
      } catch (error) {
        throw new Error(requestFailure(error));
      }
      var result;
      try {
        result = await response.json();
      } catch (_) {
        throw new Error((response.ok ? "" : "HTTP " + response.status + "：") + "OAuth 响应不是有效 JSON");
      }
      if (!response.ok) {
        throw new Error("HTTP " + response.status + "：" + (result && result.error ? result.error : "OAuth 请求失败"));
      }
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
        throw new Error("OAuth JSON 响应格式无效");
      }
      if (!result.ok) throw new Error(result.error || "OAuth 请求失败（响应未提供错误信息）");
      if (typeof result.isSupported !== "boolean") throw new Error("OAuth JSON 响应缺少状态信息");
      return result;
    }

    function emptyView(sessionId) {
      return { sessionId: sessionId, isSupported: false, platform: null, authMode: null, account: null, pending: null, busy: false, queryError: null, actionError: null };
    }

    function statusView(res, prev) {
      return Object.assign({}, prev, {
        isSupported: res.isSupported,
        platform: res.platform || null,
        authMode: res.authMode || null,
        account: res.account || null,
        pending: res.pending || null,
        queryError: null,
      });
    }

    function AccountItem(props) {
      var acc = props.acc || { loggedIn: false };
      var label = props.label;
      var platform = props.platform;
      var busy = props.busy;
      var status = acc.loggedIn
        ? acc.expired
          ? "需刷新"
          : acc.account
            ? "已登录 " + acc.account
            : "已登录"
        : "未登录";
      var cls = acc.loggedIn && !acc.expired ? "oauth-on" : acc.expired ? "oauth-err" : "oauth-off";
      var buttons = [];
      if (!acc.loggedIn) {
        buttons.push(
          React.createElement(
            "button",
            {
              key: "in",
              className: "oauth-btn",
              disabled: busy,
              onClick: function () {
                props.onStart(platform);
              },
            },
            "登录",
          ),
        );
      } else {
        buttons.push(
          React.createElement(
            "button",
            {
              key: "sw",
              className: "oauth-btn",
              disabled: busy,
              onClick: function () {
                props.onStart(platform);
              },
            },
            "换号",
          ),
        );
        if (acc.expired) {
          buttons.push(
            React.createElement(
              "button",
              {
                key: "rf",
                className: "oauth-btn",
                disabled: busy,
                onClick: function () {
                  props.onRefresh(platform);
                },
              },
              "刷新",
            ),
          );
        }
        buttons.push(
          React.createElement(
            "button",
            {
              key: "out",
              className: "oauth-btn",
              disabled: busy,
              onClick: function () {
                props.onLogout(platform);
              },
            },
            "退出",
          ),
        );
      }
      return React.createElement(
        "span",
        { className: "oauth-item" },
        label + " ",
        React.createElement("span", { className: cls }, status),
        buttons,
      );
    }

    function DengluBar(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : "";
      var modelProjection = props && props.useProjection ? props.useProjection("modelSelection") : undefined;
      var model = modelProjection && (modelProjection.next || modelProjection.lastUsed);
      var provider = model ? model.provider : null;
      var selectionKey = props && props.useProjection ? (model ? model.provider + "/" + model.model : modelProjection ? "default" : "pending") : "host";
      function blank() { return Object.assign(emptyView(sessionId), { selectionKey: selectionKey }); }
      var state = React.useState(blank);
      var view = state[0];
      var setView = state[1];
      var scopeRef = React.useRef(null);
      if (!scopeRef.current || scopeRef.current.sessionId !== sessionId || scopeRef.current.selectionKey !== selectionKey) {
        if (scopeRef.current) { scopeRef.current.alive = false; scopeRef.current.controller.abort(); }
        scopeRef.current = { sessionId: sessionId, selectionKey: selectionKey, controller: new AbortController(), alive: false, epoch: 0, query: 0, busy: false };
      }
      var scope = scopeRef.current;
      // Clear old model/account synchronously, before effects or late replies.
      if (view.sessionId !== sessionId || view.selectionKey !== selectionKey) view = blank();
      function current() {
        return scope.alive && scopeRef.current === scope;
      }

      React.useEffect(
        function () {
          scope.alive = true;
          setView(blank());
          function load() {
            if (!current() || scope.busy || (selectionKey !== "host" && selectionKey !== "default" && (!provider || (provider !== "xai" && provider !== "openai-codex")))) return;
            var epoch = scope.epoch;
            var query = ++scope.query;
            function fresh() { return current() && epoch === scope.epoch && query === scope.query; }
            var qs = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
            if (provider) qs += (qs ? "&" : "?") + "provider=" + encodeURIComponent(provider);
            request(API_PATH + qs, { signal: scope.controller.signal })
              .then(function (res) {
                if (!fresh()) return;
                setView(function (prev) {
                  return fresh() ? statusView(res, prev) : prev;
                });
              })
              .catch(function (error) {
                if (!fresh()) return;
                setView(function (prev) {
                  return fresh() ? Object.assign(blank(), { actionError: prev.actionError, queryError: error.message }) : prev;
                });
              });
          }
          load();
          var timer = setInterval(load, 2000);
          return function () {
            scope.alive = false;
            scope.epoch++;
            scope.controller.abort();
            clearInterval(timer);
          };
        },
        [sessionId, selectionKey],
      );

      function run(action, platform) {
        if (!current() || scope.busy) return;
        scope.busy = true;
        var epoch = ++scope.epoch;
        function fresh() { return current() && epoch === scope.epoch; }
        setView(function (prev) {
          return fresh() ? Object.assign({}, prev, { busy: true, actionError: null }) : prev;
        });
        request(API_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: scope.controller.signal,
          body: JSON.stringify(Object.assign({ action: action, platform: platform }, sessionId ? { sessionId: sessionId } : {}, provider ? { provider: provider } : {})),
        })
          .then(function (res) {
            if (!fresh()) return;
            scope.busy = false;
            setView(function (prev) {
              return fresh() ? Object.assign(statusView(res, prev), { busy: false, actionError: null }) : prev;
            });
          })
          .catch(function (error) {
            if (!fresh()) return;
            scope.busy = false;
            setView(function (prev) {
              return fresh() ? Object.assign({}, prev, { busy: false, actionError: error.message }) : prev;
            });
          });
      }

      var pending = view.pending;
      var pendingLine = null;
      if (pending) {
        pendingLine = React.createElement(
          "span",
          { className: "oauth-item" },
          pending.error
            ? React.createElement("span", { className: "oauth-err" }, pending.error)
            : !pending.verificationUri
              ? React.createElement("span", null, "正在申请设备码…")
              : React.createElement(
                "span",
                null,
                "请在浏览器打开 ",
                React.createElement(
                  "a",
                  { href: pending.verificationUri, target: "_blank", rel: "noreferrer" },
                  pending.label + " 授权",
                ),
                pending.userCode
                  ? React.createElement("span", null, " 代码 ", React.createElement("span", { className: "oauth-code" }, pending.userCode))
                  : null,
              ),
          React.createElement(
            "button",
            {
              className: "oauth-btn",
              disabled: view.busy,
              onClick: function () {
                run("cancel", pending.platform || view.platform);
              },
            },
            "取消",
          ),
        );
      }

      var errors = [view.actionError, view.queryError].filter(Boolean).map(function (error, index) {
        return React.createElement("span", { key: "error-" + index, className: "oauth-err", role: "alert" }, error);
      });
      if (!view.isSupported && !pending && !errors.length) return null;
      var authLine = view.authMode === "api-key"
        ? React.createElement("span", { className: "oauth-item" }, "模型使用 API key；退出 OAuth 不影响该认证")
        : null;
      var item = null;
      if (view.platform === "grok" || view.platform === "gpt") {
        item = React.createElement(AccountItem, {
          label: (view.platform === "grok" ? "Grok" : "GPT") + (view.authMode === "api-key" ? " OAuth" : ""),
          platform: view.platform,
          acc: view.account || { loggedIn: false },
          busy: view.busy || Boolean(pending && !pending.error),
          onStart: function (p) {
            run("start", p);
          },
          onLogout: function (p) {
            run("logout", p);
          },
          onRefresh: function (p) {
            run("refresh", p);
          },
        });
      }
      return React.createElement("span", { className: "oauth-bar" }, authLine, item, pendingLine, errors);
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "OAuth", order: 8, label: "账号登录" },
          function (slotProps) {
            return React.createElement(DengluBar, { sessionId: slotProps && slotProps.sessionId, useProjection: slotProps && slotProps.useProjection });
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
