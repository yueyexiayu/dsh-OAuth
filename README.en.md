<div align="center">
<img src="docs/repo-assets/hero.svg" width="100%" alt="Original concept of official device authorization, Host credentials and the login strip; not an account screenshot" />
<h1>OAuth · Account management</h1>
<p><strong>Manage Grok and Codex accounts on the plugin page and beside the composer, without copying authentication protocols.</strong></p>
<p>Official OAuth device login, multi-account switching and removal for DeepSeek Harness desktop.</p>
<p><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p><a href="package.json">v0.1.4</a> · <a href="LICENSE">MIT</a> · DSH desktop plugin</p>
<p><a href="#features">Features</a> · <a href="#how-it-works">How it works</a> · <a href="#quick-start">Quick start</a> · <a href="#accounts-and-configuration">Accounts and configuration</a> · <a href="#validation">Validation</a></p>
</div>

---

A reference for a personal DSH desktop workflow. The plugin detail page manages Grok and Codex accounts, while the composer keeps showing the current provider status. Registered official flows perform authorization and tokens stay in the Host. Verify your DSH version and provider entitlement rather than copying personal settings unchanged.

## Features

<table><tr>
<td width="33%"><strong>🔑 Official device login</strong><br/><br/>Show saved accounts and login controls on the plugin page while the official flow owns the device notice, polling and PKCE.</td>
<td width="33%"><strong>🔄 Multiple accounts</strong><br/><br/>Archive the current grant before adding another, write a selected account back to the official key, and attempt remote revocation on deletion.</td>
<td width="33%"><strong>🧭 Session-aware status</strong><br/><br/>Follow official model projections, clear stale account state and inspect history without resuming an Agent.</td>
</tr><tr>
<td><strong>🧩 Missing-route setup</strong><br/><br/>Inherit the official model catalog, retain existing configuration and use versioned concurrent writes.</td>
<td><strong>🛡 Host credentials</strong><br/><br/>No tokens in the Client or conversation and no access to other CLI auth.json files.</td>
<td><strong>🧾 Explicit outcomes</strong><br/><br/>Distinguish local logout from failed remote revocation, and saved credentials from failed route configuration.</td>
</tr></table>

## How it works

![The session selects a provider, the official flow handles device authorization and Host credential persistence, and the strip reports the outcome.](docs/repo-assets/workflow.en.svg)

Calls official `authorization.begin({key, method: "oauth", interaction, signal})`. Registered `llm-pi-ai` flows own device codes, polling, PKCE, expiry and persistence. The current account remains under the official credential key; additional accounts are stored as this plugin's grant records and selected records are written back to that key. The page refreshes the archived copy of the active account so later switches retain the latest returned token.

## Quick start

Requires official DSH desktop and appropriate Grok/ChatGPT Codex account access. The original integration targets Grok/SuperGrok/X Premium and ChatGPT Plus/Pro Codex; actual provider acceptance determines availability.

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
git clone https://github.com/yueyexiayu/dsh-OAuth.git "$DSH_HOME/plugins/OAuth"
```

Merge into `$DSH_HOME/profiles/desktop/cordis.patch.yml`, preserving other entries and the case-sensitive `OAuth` name:

```yaml
- insert:
    - id: OAuth
      name: ../../plugins/OAuth/lib/index.js
```

**Quit DSH fully with ⌘Q and reopen it.** Open "Plugins → Account sign-in" to manage Codex and Grok accounts. The composer still provides login, switch, refresh and logout controls for the current provider. Follow the official device notice to finish authorization. Do not use CLI plugin management to alter the desktop profile; no official desktop rebuild is required.

## Accounts and configuration

| Item | Behavior |
| --- | --- |
| Current account | Host `$DSH_HOME/.credentials.yaml`: `llm-pi-ai/xai`, `llm-pi-ai/openai-codex` |
| Saved accounts | `oauth-accounts/grok-*` and `oauth-accounts/gpt-*` grants; the Client receives only safe status, never tokens |
| Supported platforms | Codex (`openai-codex`) and Grok (`xai`) only |
| Switching | Archive the active account, then write the selected grant to its official credential key |
| Deletion | Remove the current or saved account and attempt remote revocation; report local deletion and remote failure separately |
| Session selection | Official read-only `sessionQuery.observeSession`, `modelSelection.next ?? lastUsed` |
| Default model | Only an entry without sessionId or a confirmed existing empty session with no model selection |
| API Key routes | Explicitly state that OAuth logout does not change that authentication method |
| Route setup | Official `settings.describe/mutate`, preserving existing models/routes and rechecking version conflicts |

<details>
<summary><strong>Cancellation, races and failure semantics</strong></summary>

- Adding, switching or logging out first cancels the credential key's flow and awaits `authorization/settled`. Unload, cancel and provider changes stop flows initiated here; arbitrary third-party flows ignoring cancellation cannot be guaranteed.
- Invalid sessionId returns 400; nonexistent sessions 404; changed/mismatched model or account 409. History, format, projection and persistence errors fail explicitly, without querying an unrelated global account.
- The Client subscribes to model projections; the Host rechecks ownership after async work. Late responses cannot replace new state, and background queries do not erase operation errors.
- Refresh requires valid access tokens. Missing expiry uses the official default; provided expiry must be finite/positive. Omitted refresh tokens retain the old value; present invalid ones fail without replacing credentials. A valid completed rotation survives later configuration failure or unload.
- Unsupported remote revocation is an explicit failure; local credentials are still removed and both outcomes are reported. Unsupported prompts and authorization/persistence errors are not reported as success.
- Known credentials are redacted from errors, not every unknown opaque token. The plugin never reads/writes `~/.grok/auth.json` or `~/.codex/auth.json`; no account credentials are included.

</details>

## Validation

```sh
cd "$DSH_HOME/plugins/OAuth"
for file in lib/*.js scripts/*.mjs test/*.mjs; do node --check "$file" || exit 1; done
node --test
```

Optional official-component verification:

```sh
DSH_OFFICIAL_NODE_MODULES=/absolute/path/to/official/node_modules node --test scripts/verify-official.mjs
```

Automated checks use synthetic data and an in-memory credential queue. Plugin and client regression tests cover account listing, login archiving, switching, deletion, provider restrictions and error states without reading real accounts. The update was also loaded after a desktop restart under DSH 0.2.2-rc.1, and the plugin page showed v0.1.4, Codex/Grok account lists, login buttons and delete controls. No real account authorization or remote revocation was executed.

## License

[MIT License](LICENSE). Remove only this plugin's desktop entry and fully restart to uninstall; deleting a plugin is not proof of remote token revocation.

<div align="center"><sub>Official authorization. Factual status. · <a href="README.md">阅读中文版 →</a></sub></div>
