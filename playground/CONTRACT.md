# Playground 契约（v1）

本目录是本地调试用的「钉钉聊天界面仿真器」，不是发布产物（不在 npm tarball 白名单内）。

目标：用**真实**的 `lib/renderer.js` 计算每一帧卡片内容，浏览器只负责把它画成钉钉聊天的样子。
因此 Playground 里看到的 markdown / 活动行 / rollover / 失败态，与线上发送给钉钉的内容逐字一致。

范围：仅 AI Card + Markdown 回复形态。A2UI 交互卡片不在 v1 范围。

## 文件布局与归属

```
playground/
  CONTRACT.md        # 本文件（Lead 维护）
  server.mjs         # HTTP 服务：静态资源 + JSON API（runner-builder）
  runner.mjs         # 用真实 Renderer 跑剧本，产出 timeline（runner-builder）
  scenarios.mjs      # 剧本数据（runner-builder）
  public/
    index.html       # 页面骨架（ui-builder）
    style.css        # 钉钉视觉（ui-builder）
    app.js           # 播放器 / 面板 / 状态（ui-builder）
    markdown.js      # 钉钉口径 markdown -> HTML（markdown-renderer）
    fixtures/demo-run.json  # 一份 /api/run 的样例响应，供离线开发（Lead）
test/
  playground.test.mjs       # runner/server 测试（runner-builder）
  markdown.test.mjs         # markdown 渲染测试（markdown-renderer）
```

约定：只改自己名下的文件；跨文件需求写到 `playground/CONTRACT.md` 之外的 issue 消息里，不要直接改别人的文件。

## 启动

```bash
pnpm run playground        # = pnpm run build && node playground/server.mjs [--port 5188] [--no-open]
```

服务默认监听 `127.0.0.1:5188`，根路径 `/` 返回 `public/index.html`。
静态资源按扩展名给 `Content-Type`；不做目录穿越（解析后的路径必须仍在 `public/` 内）。

## HTTP API

### `GET /api/scenarios`

```json
{
  "scenarios": [
    {
      "id": "rollover",
      "title": "超长输出自动换卡",
      "description": "把 maxCardChars 调小触发定稿 + 新卡续写",
      "tags": ["rollover", "边界"],
      "mode": "aicard",
      "conversationType": "direct",
      "conversationTitle": "DSH 助手",
      "defaults": {
        "replyMode": "aicard",
        "lifecycle": "finalize",
        "throttleMs": 500,
        "maxCardChars": 240,
        "conversationType": "direct"
      }
    }
  ]
}
```

`mode` ∈ `aicard` | `markdown` | `text`；`conversationType` ∈ `direct` | `group`。
`defaults` 是该剧本设计时使用的完整有效默认值（已与全局默认合并）。UI 必须用它初始化设置面板：
**只有用户手动改过的字段才放进 `POST /api/run` 的 `options`**，否则剧本会失掉自己的语义
（例如 `rollover` 的 240 字上限、`markdown-mode` 的非卡片载体）。

### `POST /api/run`

请求体（全部可选，除 `scenarioId`）：

```json
{
  "scenarioId": "tool-run",
  "options": {
    "replyMode": "aicard",
    "lifecycle": "stream",
    "throttleMs": 250,
    "maxCardChars": 6000,
    "conversationType": "direct",
    "pace": 1
  }
}
```

- `lifecycle` ∈ `stream` | `finalize`（对应 `AICard` 的两种写入策略）
- `pace`：剧本节奏倍率（1 = 真实节奏；测试用小值加速；服务端最小按 0.05 处理）
- 未知字段忽略；非法枚举回 400 `{ "error": "invalid_option", "field": "..." }`
- 未知 `scenarioId` 回 404 `{ "error": "unknown_scenario" }`

响应 200：

```json
{
  "scenario": {
    "id": "tool-run",
    "title": "...",
    "description": "...",
    "mode": "aicard",
    "conversationType": "direct"
  },
  "options": {
    "replyMode": "aicard",
    "lifecycle": "stream",
    "throttleMs": 250,
    "maxCardChars": 6000,
    "conversationType": "direct",
    "pace": 1
  },
  "conversation": {
    "type": "direct",
    "title": "DeepSeek Harness",
    "robotName": "DeepSeek Harness",
    "user": { "nick": "牧曈", "staffId": "u_demo" }
  },
  "durationMs": 5231,
  "timeline": [/* Entry[]，见下 */],
  "logs": [{ "t": 12, "line": "card settled (842 chars)" }],
  "stats": { "entries": 31, "frames": 21, "cards": 2, "finalChars": 842 }
}
```

### `POST /api/normalize`

请求 `{ "text": "...", "normalize": true }` → 200

```json
{ "input": "...", "output": "...", "changed": true, "notes": ["第 12 行前补了 1 个空行以修复表格渲染"] }
```

`normalize: true` 调用真实 `ensureTableBlankLines`（`src/aicard.ts` 导出的 `normalizeCardContent`）。
`notes` 可为空数组；不确定时宁可不写。

### `GET /api/activity-lines`

活动行画廊，全部由真实 `describeToolCall` / `renderActivityLine` 生成：

```json
{
  "groups": [
    {
      "variant": "bash",
      "name": "bash",
      "sample": "运行测试",
      "lines": {
        "running": "> ⚙️ 正在执行命令 · 运行测试",
        "done": "> ✅ 已执行命令 · 运行测试",
        "error": "> ❌ 执行命令失败 · 运行测试",
        "stopped": "> ⏹️ 执行命令已停止 · 运行测试"
      }
    }
  ],
  "thinking": "> 💭 正在思考…"
}
```

## Timeline Entry

所有 entry 都有 `t`（相对开始时的毫秒整数，非递减）与 `type`：

| type          | 载荷                                    | UI 行为                                             |
| ------------- | --------------------------------------- | --------------------------------------------------- |
| `inbound`     | `{ text, msgId }`                       | 追加一条用户气泡                                    |
| `reaction`    | `{ state: "add" \| "recall", text }`    | 用户气泡上的表情回应（钉钉「🤔思考中」）出现/消失   |
| `card-create` | `{ cardId }`                            | 追加一张空的 AI 卡片气泡（进入「输入中」态）        |
| `card-frame`  | `{ cardId, kind, flowStatus, content }` | 用 `content` 覆盖该卡片正文                         |
| `markdown`    | `{ title, text }`                       | 追加一条 markdown 消息气泡（`sessionWebhook` 通道） |
| `text`        | `{ text }`                              | 追加一条纯文本气泡                                  |
| `turn-end`    | `{ reason }`                            | 无渲染，供调试面板标注                              |

`card-frame`：

- `kind` ∈ `stream` | `finish` | `fail` | `update`（对应 card 对象被调用的方法）
- `flowStatus` ∈ `inputing` | `finished` | `failed`
  - `inputing`：卡片处于钉钉「输入中」态（`lifecycle: "stream"` 下的中间帧）
  - `finished`：已定型，不再显示输入中指示
  - `failed`：失败态
- `content` 是**已规范化**的 markdown（与真实发往 `card/streaming` 的 `content` 一致）

不变式（测试会检查）：

- 任一 `card-frame` 之前必须先有对应 `cardId` 的 `card-create`
- 最后一张卡片一定收到 `finished` 或 `failed`
- `kind: "fail"` ⇒ `flowStatus: "failed"`

## 前端契约

- 纯静态 ES module，无构建步骤、无外部 CDN、无第三方依赖。
- `app.js` 通过 `fetch('/api/scenarios')` 与 `fetch('/api/run', { method: 'POST' })` 取数；
  服务未启动时给出可读的失败提示（并可用 `fixtures/demo-run.json` 兜底，方便直接 review 页面）。
  `fixtures/demo-run.json` 就是一次 `POST /api/run`（`scenarioId: "tool-run"`，默认 options）的完整响应体，
  离线时可直接当作唯一场景渲染；`/api/scenarios` 取不到时，用它的 `scenario` 字段构造单条列表。
- `markdown.js` 导出：

```js
/** @param {string} src @param {{ lineBreakAsBr?: boolean }} [options] @returns {string} HTML */
export function renderMarkdown(src, options)
```

只返回 HTML 字符串；所有文本必须转义，禁止透传原始 HTML 标签。

- 播放器：`timeline` 逐条应用；支持 播放/暂停/单步/重置/进度拖动/倍速；任意时刻可回退（回退 = 从头重放前 i 条）。
- 调试面板：每条 entry 一行（t / type / cardId / 字符数），点击可查看该帧原始 markdown 并可一键复制。
- 「Markdown 实验室」：textarea 输入 → 实时预览；开关「卡片规范化」调用 `/api/normalize` 对比前后差异。
- 「活动行画廊」：展示 `/api/activity-lines` 的结果。
