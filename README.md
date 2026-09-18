# OAuth

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

DeepSeek Harness 官方桌面端的账号登录条。在输入框下方显示 **Grok** / **GPT** 登录状态，可用官方 OAuth（xAI 设备码、ChatGPT Codex 设备码）登录、换号、退出。

token 只写在 Host 的 `$DSH_HOME/.credentials.yaml`（`llm-pi-ai/xai`、`llm-pi-ai/openai-codex`），不会进渲染进程或对话。不要读取或改写 `~/.grok/auth.json` / `~/.codex/auth.json`。

## 安装

复制到 `$DSH_HOME/plugins/OAuth`，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: OAuth
      name: ../../plugins/OAuth/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。输入框下方会出现 Grok / GPT 登录按钮。

## 说明

- Grok 需要 SuperGrok / X Premium；GPT 需要 ChatGPT Plus / Pro 的 Codex 权限
- 登录会补上缺失的 `llm-pi-ai` 路由，但不会覆盖你已有的模型列表
- 仓库不含账号或凭据

## 开发

```bash
node --check lib/index.js lib/client.js lib/parse.js lib/oauth.js
node --test
```
