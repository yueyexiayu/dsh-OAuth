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
- 登录正式调用官方 `authorization.begin({ key, method: "oauth", interaction, signal })`，由已注册的 `llm-pi-ai` flow 负责设备码、轮询、PKCE、期限及凭据提交；插件不再复制这些协议实现
- 保留输入框下的设备码交互：显示官方 notice 的链接和 code，Codex 官方 select 提供 `device_code` 时明确选择设备登录，不默选 browser；不支持的 prompt、授权或持久化失败均明确显示
- 换号、退出先取消相同凭据 key 的授权，并等待官方 `authorization/settled`，再启动下一次授权或删除凭据，避免已经接受的官方提交复活账号；取消、卸载及当前会话切换到其他提供方时中止本插件发起的官方 flow。不能保证任意忽略取消信号的第三方授权流
- 当前会话模型通过官方只读 `sessionQuery.observeSession` 的 `modelSelection.next ?? lastUsed` 读取；活跃会话和未恢复的历史会话使用同一契约并释放 observation，不为查询启动或恢复 Agent。只有无 sessionId 的新入口或已确认存在但尚无模型选择的空会话使用默认模型
- 显式无效的 sessionId 返回 400；不存在的会话返回 404，持久化、格式、模型投影或读取异常返回错误，不回落到无关全球账号。start / refresh / logout / cancel 都校验当前提供方；模型已切换或请求账号不匹配返回 409
- Client 订阅槽位的 `useProjection("modelSelection")`，会话或模型切换立即清空旧账号，并使旧请求失效；Host 在异步账号查询结束后再次核对选择，迟到响应不能显示旧提供方
- xAI 刷新响应必须含合法 access token；有效期未返回时采用官方默认值，存在时须为有限正数。省略 refresh token 时保留原值，字段存在但无效时拒绝且保留旧凭据。已完成轮换的合法凭据仍会保存，不因后续模型验证、路由配置失败或卸载而丢失
- 配置了 `apiKeyEnv` 的模型路由会明确显示「模型使用 API key；退出 OAuth 不影响该认证」，不会通过登录或退出自动切换认证方式
- 网络、HTTP、JSON、业务及持久化失败会明确显示；远端不支持该 token 类型的吊销返回失败提示，不再冒充成功。远端失败仍删除本地凭据，并明确区分两者。后台查询不会清除操作错误，旧请求和旧会话结果不会覆盖新状态。协议和 Host 错误会脱敏已知凭据，但不声称能识别任意未知 opaque token
- 修改插件后需要完全退出桌面应用（⌘Q）再打开；无需重新构建桌面端
- 仓库不含账号或凭据

## 开发

```bash
for file in lib/*.js scripts/*.mjs test/*.mjs; do node --check "$file" || exit 1; done
node --test
```

已核对桌面运行时 `0.2.1-alpha.2` 的官方接口。可选：把 `DSH_OFFICIAL_NODE_MODULES` 指向已解包的官方运行时依赖目录，核验实际 `llm-pi-ai` flow 的 xAI / Codex 设备码 notice、取消，以及 authorization 已提交写入和退出竞态：

```bash
DSH_OFFICIAL_NODE_MODULES=/absolute/path/to/official/node_modules node --test scripts/verify-official.mjs
```

该验证使用真实官方组件和 synthetic 数据，但凭据提供器仅为内存 FIFO 队列，不联网、不读取或修改真实账号、配置或凭据。组件测试和模拟响应下的浏览器检查不能代替完全重启桌面端后的实际登录验收。
