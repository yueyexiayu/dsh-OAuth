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
      ".oauth-bar { display: inline-flex; align-items: center; gap: 10px; font-size: 11px; line-height: 1.5; " +
      "color: var(--dsw-alias-label-secondary); white-space: nowrap; user-select: none; } " +
      ".oauth-item { display: inline-flex; align-items: center; gap: 4px; } " +
      ".oauth-on { color: var(--dsw-alias-state-success-primary); font-weight: 600; } " +
      ".oauth-off { color: var(--dsw-alias-label-secondary); } " +
      ".oauth-err { color: var(--dsw-alias-state-error-primary); } " +
      ".oauth-btn { border: 0; background: transparent; color: var(--dsw-alias-label-primary); " +
      "cursor: pointer; font-size: 11px; padding: 0 2px; } " +
      ".oauth-btn:hover { text-decoration: underline; } " +
      ".oauth-code { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-label-primary); }";

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function post(action, platform) {
      return fetch(API_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: action, platform: platform }),
      }).then(function (r) {
        return r.json();
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

    function DengluBar() {
      var state = React.useState({ grok: { loggedIn: false }, gpt: { loggedIn: false }, pending: null, busy: false });
      var view = state[0];
      var setView = state[1];

      React.useEffect(function () {
        var alive = true;
        function load() {
          fetch(API_PATH)
            .then(function (r) {
              return r.json();
            })
            .then(function (res) {
              if (!alive || !res || !res.ok) return;
              setView(function (prev) {
                return {
                  grok: res.grok || { loggedIn: false },
                  gpt: res.gpt || { loggedIn: false },
                  pending: res.pending,
                  busy: prev.busy,
                };
              });
            })
            .catch(function () {});
        }
        load();
        var timer = setInterval(load, 2000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      function run(action, platform) {
        setView(function (prev) {
          return Object.assign({}, prev, { busy: true });
        });
        post(action, platform)
          .then(function (res) {
            if (!res || !res.ok) {
              setView(function (prev) {
                return Object.assign({}, prev, { busy: false, pending: res && res.error ? { error: res.error } : prev.pending });
              });
              return;
            }
            setView({
              grok: res.grok || { loggedIn: false },
              gpt: res.gpt || { loggedIn: false },
              pending: res.pending,
              busy: false,
            });
          })
          .catch(function () {
            setView(function (prev) {
              return Object.assign({}, prev, { busy: false });
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
              onClick: function () {
                run("cancel");
              },
            },
            "取消",
          ),
        );
      }

      return React.createElement(
        "span",
        { className: "oauth-bar" },
        React.createElement(AccountItem, {
          label: "Grok",
          platform: "grok",
          acc: view.grok,
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
        }),
        React.createElement(AccountItem, {
          label: "GPT",
          platform: "gpt",
          acc: view.gpt,
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
        }),
        pendingLine,
      );
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "OAuth", order: 8, label: "账号登录" },
          function () {
            return React.createElement(DengluBar);
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
