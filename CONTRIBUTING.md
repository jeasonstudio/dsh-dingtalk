# 贡献指南

感谢参与 DSH 钉钉连接器。外部贡献通过 GitHub Issue 和 Pull Request 进行。

## 开始开发

```bash
pnpm install
pnpm run ci
```

请勿在测试、日志、Issue 或提交中加入真实 Client Secret、二维码、绑定口令、聊天内容或内部地址。

## 调试输出观感（Playground）

改动卡片文案、活动行或 markdown 排版时，不必每次回到真实钉钉验证：

```bash
pnpm run playground
```

本地打开 `http://127.0.0.1:5188` 的钉钉聊天仿真器，帧内容由真实 `lib/renderer.js` 录制生成，
可以选择剧本、逐帧回放、查看每帧原始 markdown、在实验室里试排版。说明见 [playground/README.md](playground/README.md)。
它只仿真 AI Card 与 markdown 承载，真机观感仍需最后验收一遍。

## Pull Request

- 一个 PR 只解决一个清晰问题。
- 标题使用 Conventional Commits，例如 `fix(stream): reconnect after heartbeat timeout`。
- 功能修改应补充行为测试；测试通过公开 CLI、运行时行为或 NPM tarball 边界验证，不绑定私有实现。
- 描述中说明用户影响、验证命令和已知限制。
- 维护者使用 squash merge，最终 PR 标题决定自动版本号。

较大的行为或接口变化请先创建 Issue 对齐设计。

## Agent setup 宿主回归

严格 Cordis 回归通过真实的 `inject` 检查拒绝 `ctx.agent` 服务访问，并验证机器人、数字员工及旧 A2UI 输入类型：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run ci
```

公开 DSH `0.2.0-rc.2` 的宿主契约 smoke 使用隔离安装树，不读取现有 DSH 配置、不启动 Channel，也不调用模型：

```bash
smoke_dir=$(mktemp -d)
npm install --prefix "$smoke_dir" --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
DSH_SMOKE_NODE_MODULES="$smoke_dir/node_modules" node scripts/smoke-agent-setup.mjs
DSH_SMOKE_NODE_MODULES="$smoke_dir/node_modules" node scripts/smoke-workspace.mjs
rm -rf "$smoke_dir"
```

运行 smoke 前需已构建连接器。它验证真实宿主的创建、持久化恢复、已加载补装、重复安装与 setup 失败回滚后重试；真实钉钉端到端验收需另行执行。

工作区 smoke 使用真实宿主的 WorkspaceRegistry、JSON 存储及会话服务，检查 `/cd`、`/new`、`/model`、恢复和已加载会话的 cwd 与显式工作区归属一致，以及 `/cd reset` 返回默认分组。它不启动钉钉 Channel、不发送消息、不调用模型。
