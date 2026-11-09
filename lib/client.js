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
      ".oauth-code { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-label-primary); } " +
      ".oauth-accounts { display: grid; gap: 14px; margin: 18px 0 22px; color: var(--dsw-alias-label-primary); } " +
      ".oauth-accounts-intro { margin: -2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }".replace("13px", "var(--dsw-alias-font-size-2, 13px)") +
      ".oauth-platform { overflow: hidden; border: 1px solid var(--dsw-alias-border-l3, #dfe2e8); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #fafbfc); } " +
      ".oauth-platform-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l3, #e7e9ee); } " +
      ".oauth-platform-title { display: flex; align-items: center; gap: 11px; min-width: 0; } " +
      ".oauth-platform-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, #dfe2e8); font-weight: 700; } " +
      ".oauth-platform-name { font-size: 14px; font-weight: 650; line-height: 1.35; } " +
      ".oauth-platform-meta { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; } " +
      ".oauth-primary { min-height: 36px; border: 1px solid var(--dsw-alias-state-business-primary, #0877ff); border-radius: 9px; background: var(--dsw-alias-state-business-primary, #0877ff); color: #fff; cursor: pointer; font: inherit; font-size: 13px; font-weight: 650; padding: 0 13px; white-space: nowrap; } " +
      ".oauth-primary:hover:not(:disabled) { filter: brightness(0.96); } " +
      ".oauth-primary:disabled { cursor: default; opacity: 0.48; } " +
      ".oauth-primary:focus-visible, .oauth-row-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #0877ff); outline-offset: 2px; } " +
      ".oauth-account-list { display: grid; } " +
      ".oauth-account-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; min-height: 58px; padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l3, #ebedf1); } " +
      ".oauth-account-row:first-child { border-top: 0; } " +
      ".oauth-account-identity { min-width: 0; } " +
      ".oauth-account-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; } " +
      ".oauth-account-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; } " +
      ".oauth-pill { display: inline-flex; align-items: center; min-height: 20px; border-radius: 999px; padding: 0 7px; background: var(--dsw-alias-bg-layer-2, #eef1f5); font-size: 11px; font-weight: 600; } " +
      ".oauth-pill-active { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #16883d) 12%, transparent); color: var(--dsw-alias-state-success-primary, #16883d); } " +
      ".oauth-pill-expired { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b47) 10%, transparent); color: var(--dsw-alias-state-error-primary, #c53b47); } " +
      ".oauth-row-actions { display: flex; align-items: center; gap: 6px; } " +
      ".oauth-row-btn { min-height: 32px; border: 1px solid var(--dsw-alias-border-l3, #dfe2e8); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 12px; padding: 0 10px; } " +
      ".oauth-row-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f0f2f5); } " +
      ".oauth-row-btn-danger { color: var(--dsw-alias-state-error-primary, #c53b47); } " +
      ".oauth-row-btn:disabled { cursor: default; opacity: 0.45; } " +
      ".oauth-empty { padding: 18px 16px 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; } " +
      ".oauth-account-note { padding: 0 16px 14px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; } " +
      ".oauth-pending-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--dsw-alias-border-l3, #ebedf1); background: var(--dsw-alias-bg-layer-2, #f4f6f8); font-size: 12px; } " +
      ".oauth-pending-row a { color: var(--dsw-alias-state-business-primary, #0877ff); font-weight: 600; } " +
      ".oauth-accounts-error { color: var(--dsw-alias-state-error-primary, #c53b47); font-size: 13px; } " +
      "@media (max-width: 640px) { .oauth-platform-head { align-items: flex-start; } .oauth-account-row { grid-template-columns: 1fr; gap: 8px; } .oauth-row-actions { justify-content: flex-start; } .oauth-platform-head { flex-wrap: wrap; } .oauth-primary { width: 100%; } }";

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

    function AccountsPage(props) {
      var shown = React.useState(null);
      var data = shown[0];
      var setData = shown[1];
      var pendingState = React.useState(false);
      var loading = pendingState[0];
      var setLoading = pendingState[1];
      var busyState = React.useState("");
      var busy = busyState[0];
      var setBusy = busyState[1];
      var actionErrorState = React.useState("");
      var actionError = actionErrorState[0];
      var setActionError = actionErrorState[1];
      var queryErrorState = React.useState("");
      var queryError = queryErrorState[0];
      var setQueryError = queryErrorState[1];
      var noticeState = React.useState("");
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var confirmState = React.useState("");
      var confirming = confirmState[0];
      var setConfirming = confirmState[1];
      var mounted = React.useRef(true);
      var loadingRef = React.useRef(false);
      var busyRef = React.useRef(false);
      var epochRef = React.useRef(0);

      function load(signal) {
        if (loadingRef.current || busyRef.current) return Promise.resolve();
        loadingRef.current = true;
        var epoch = epochRef.current;
        setLoading(true);
        return request(API_PATH + "?view=accounts", { cache: "no-store", signal: signal })
          .then(function (body) {
            if (!mounted.current || epoch !== epochRef.current || (signal && signal.aborted)) return;
            setData(body); setQueryError("");
          })
          .catch(function (reason) {
            if (!mounted.current || epoch !== epochRef.current || (signal && signal.aborted)) return;
            setQueryError(reason.message);
          })
          .finally(function () {
            loadingRef.current = false;
            if (mounted.current) setLoading(false);
          });
      }

      React.useEffect(function () {
        mounted.current = true;
        var controller = new AbortController();
        load(controller.signal);
        var timer = setInterval(function () { load(controller.signal); }, 3000);
        return function () {
          mounted.current = false;
          controller.abort();
          clearInterval(timer);
        };
      }, []);

      function act(action, platform, accountId) {
        if (busyRef.current) return;
        busyRef.current = true;
        var epoch = ++epochRef.current;
        var key = platform + ":" + action + (accountId ? ":" + accountId : "");
        setBusy(key); setActionError(""); setNotice("");
        var payload = { action: action, platform: platform };
        if (accountId) payload.accountId = accountId;
        request(API_PATH + "?view=accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function (body) {
            if (!mounted.current || epoch !== epochRef.current) return;
            setData(body);
            setConfirming("");
            if (body.warning) setNotice(body.warning);
            else if (action === "account-switch") setNotice("已切换当前账号。");
            else if (action === "account-delete") {
              var platformAfter = (body.accounts || []).find(function (item) { return item.id === platform; });
              var platformName = platformAfter ? platformAfter.label : platform;
              if (platformAfter && platformAfter.authMode === "api-key") setNotice("账号已删除。该模型路由使用 API key，仍会保留。");
              else setNotice(platformAfter && platformAfter.accounts.length ? "账号已删除。" : platformName + " 账号已删除，对应模型已从会话选择器隐藏。");
            }
          })
          .catch(function (reason) { if (mounted.current && epoch === epochRef.current) setActionError(reason.message); })
          .finally(function () {
            busyRef.current = false;
            if (mounted.current && epoch === epochRef.current) setBusy("");
          });
      }

      if (props && props.view && props.view !== "page") return null;
      if (!data) {
        return React.createElement(
          "section",
          { className: "oauth-accounts", "aria-label": "账号管理" },
          React.createElement("p", { className: "oauth-accounts-intro" }, loading ? "正在读取已保存的账号…" : "账号状态暂不可用。"),
          actionError ? React.createElement("p", { className: "oauth-accounts-error", role: "alert" }, actionError) : null,
          queryError ? React.createElement("p", { className: "oauth-accounts-error", role: "alert" }, queryError) : null,
          queryError ? React.createElement("button", { type: "button", className: "oauth-row-btn", onClick: function () { load(); } }, "重新读取") : null,
        );
      }

      var platforms = (data.accounts || []).filter(function (platform) { return platform.id === "gpt" || platform.id === "grok"; });
      return React.createElement(
        "section",
        { className: "oauth-accounts", "aria-label": "账号管理" },
        React.createElement("h3", null, "账号"),
        React.createElement("p", { className: "oauth-accounts-intro" }, "管理 Codex 与 Grok 的登录账号。切换后，新的账号会成为对应平台的当前凭据；没有登录账号的平台不会出现在会话模型选择中。"),
        actionError ? React.createElement("p", { className: "oauth-accounts-error", role: "alert" }, actionError) : null,
        queryError ? React.createElement("p", { className: "oauth-accounts-error", role: "alert" }, queryError) : null,
        notice ? React.createElement("p", { role: "status" }, notice) : null,
        platforms.map(function (platform) {
          var count = platform.accounts.length;
          var addKey = platform.id + ":account-add";
          var pending = platform.pending;
          return React.createElement(
            "article",
            { className: "oauth-platform", key: platform.id, "data-provider": platform.id },
            React.createElement(
              "header",
              { className: "oauth-platform-head" },
              React.createElement(
                "div",
                { className: "oauth-platform-title" },
                React.createElement("span", { className: "oauth-platform-mark", "aria-hidden": "true" }, platform.id === "gpt" ? "C" : "G"),
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "oauth-platform-name" }, platform.label),
                  React.createElement("div", { className: "oauth-platform-meta" }, count ? "已保存 " + count + " 个账号" : "尚未登录"),
                ),
              ),
              React.createElement(
                "button",
                { type: "button", className: "oauth-primary", disabled: Boolean(busy || pending && !pending.error), onClick: function () { act("account-add", platform.id); }, "aria-label": "添加 " + platform.label + " 账号" },
                busy === addKey ? "正在准备…" : count ? "添加账号" : "登录 " + platform.label,
              ),
            ),
            count
              ? React.createElement(
                "div",
                { className: "oauth-account-list" },
                platform.accounts.map(function (account) {
                  var rowKey = platform.id + ":" + account.id;
                  return React.createElement(
                    "div",
                    { className: "oauth-account-row", key: account.id },
                    React.createElement(
                      "div",
                      { className: "oauth-account-identity" },
                      React.createElement("div", { className: "oauth-account-label", title: account.label }, account.label),
                      React.createElement(
                        "div",
                        { className: "oauth-account-state" },
                        account.active ? React.createElement("span", { className: "oauth-pill oauth-pill-active" }, "当前账号") : React.createElement("span", { className: "oauth-pill" }, "已保存"),
                        account.expired ? React.createElement("span", { className: "oauth-pill oauth-pill-expired" }, "需刷新") : null,
                      ),
                    ),
                    React.createElement(
                      "div",
                      { className: "oauth-row-actions" },
                      account.active ? null : React.createElement("button", { type: "button", className: "oauth-row-btn", disabled: Boolean(busy), onClick: function () { act("account-switch", platform.id, account.id); } }, busy === platform.id + ":account-switch:" + account.id ? "切换中…" : "使用此账号"),
                      confirming === rowKey
                        ? React.createElement("button", { type: "button", className: "oauth-row-btn oauth-row-btn-danger", disabled: Boolean(busy), onClick: function () { act("account-delete", platform.id, account.id); } }, busy === platform.id + ":account-delete:" + account.id ? "删除中…" : "确认删除")
                        : React.createElement("button", { type: "button", className: "oauth-row-btn oauth-row-btn-danger", disabled: Boolean(busy), onClick: function () { setConfirming(rowKey); }, "aria-label": "删除 " + account.label }, "删除"),
                      confirming === rowKey ? React.createElement("button", { type: "button", className: "oauth-row-btn", disabled: Boolean(busy), onClick: function () { setConfirming(""); } }, "取消") : null,
                    ),
                  );
                }),
              )
              : React.createElement("div", { className: "oauth-empty" }, "还没有登录账号。点击上方按钮，按官方设备授权流程完成登录。"),
            pending
              ? React.createElement(
                "div",
                { className: "oauth-pending-row", role: "status" },
                pending.error
                  ? React.createElement("span", { className: "oauth-accounts-error" }, pending.error)
                  : !pending.verificationUri
                    ? React.createElement("span", null, "正在申请设备码…")
                    : React.createElement(
                      "span",
                      null,
                      "打开 ",
                      React.createElement("a", { href: pending.verificationUri, target: "_blank", rel: "noreferrer" }, platform.label + " 授权页"),
                      pending.userCode ? React.createElement("span", null, "，输入代码 ", React.createElement("strong", { className: "oauth-code" }, pending.userCode)) : null,
                    ),
                React.createElement("button", { type: "button", className: "oauth-row-btn", disabled: Boolean(busy), onClick: function () { act("account-cancel", platform.id); } }, "取消登录"),
              )
              : null,
          );
        }),
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
          label: (view.platform === "grok" ? "Grok" : "Codex") + (view.authMode === "api-key" ? " OAuth" : ""),
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
      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({ name: "plugins.bundle.config", key: "OAuth" }, AccountsPage);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
