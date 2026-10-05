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
- 登录或手动刷新会通过当前官方 `settings.describe/mutate` 接口补上缺失路由，继承官方安装包中的模型目录；已有模型列表和路由配置保持不变
- 路由写入携带配置版本号，遇到并发修改会重新检查；写入失败会明确显示，凭据已经保存时也不会假装路由配置成功
- 自动续期由官方模型适配器负责；本插件的手动刷新也在官方 `credentials.modifyRecord` 锁内完成，避免读取旧 refresh token 后覆盖新凭据
- 设备码快捷登录仍由插件发起，凭据与官方模型适配器共用；本次保留当前界面和交互，没有切换成中央 authorization 的通用问答流程
- 取消、换号、退出或卸载时会中止相应设备登录请求，旧轮询结果不会重新写入已取消的账号
- 修改插件后需要完全退出桌面应用（⌘Q）再打开；无需重新构建桌面端
- 仓库不含账号或凭据

## 开发

```bash
node --check lib/index.js lib/client.js lib/parse.js lib/oauth.js
node --test
```
