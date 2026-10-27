# DingTalk 输出 Playground

一个本地跑的「钉钉聊天界面仿真器」，用来看机器人回复在钉钉里长什么样，而不必每次都扫码、发消息、等真机回包。

关键点：**卡片里出现的文字不是手写的假数据，而是真实 renderer 算出来的**。
`playground/runner.mjs` 直接驱动编译后的 `lib/renderer.js`，只把「AI 卡片」和「sessionWebhook 回复」换成录制器，
因此帧内容、过程线的拼装与收起规则、节流时序、rollover 指针、失败态文案，与线上发往钉钉的完全一致。

```
scenarios.mjs ──► runner.mjs ──► lib/renderer.js ──► 录制 card.stream/finish/fail
                      │                                     │
                      └────────── timeline (JSON) ◄─────────┘
                                     │
                          server.mjs │ HTTP
                                     ▼
                        public/index.html + app.js（钉钉形状的聊天窗口）
```

## 快速开始

```bash
pnpm install          # 首次
pnpm run playground   # = pnpm run build && node playground/server.mjs
```

默认打开 `http://127.0.0.1:5188`（自动拉浏览器）。

```bash
node playground/server.mjs --port 5199 --no-open   # 换端口 / 不自动开浏览器
```

要求 Node.js `^22.19.0 || >=24.0.0`。零运行时依赖，离线可用（`lib/` 需要先 build）。

> **必须通过本地服务打开，直接双击 `public/index.html` 看不到内容。**
> 页面用的是浏览器原生 ES module，`file://` 协议下会被 CORS 拦掉；而且帧内容要靠服务端驱动真实
> `lib/renderer.js` 才有意义 —— 双击模式只能给一份写死的假数据，调试价值不大。
> 双击时的提示页会告诉你正确入口。

## 界面怎么用

| 区域            | 用途                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 顶部工具条      | 选剧本 → 运行；播放/暂停/单步/重置/倍速/进度拖动；打开设置；`壳标注` 开关                                           |
| 左侧剧本列表    | 10 个内置剧本，点一下直接跑                                                                                         |
| 中间聊天窗口    | 钉钉形状的群聊/单聊，包含用户气泡、AI 卡片、markdown 消息、表情回应                                                 |
| 右侧帧检查器    | timeline 每一条的 `t / type / cardId / 字符数`；点开看该帧原始 markdown，可复制、可载入实验室                       |
| Markdown 实验室 | 粘贴任意 markdown 实时预览；开关「卡片规范化」对比 `ensureTableBlankLines` 前后差异                                 |
| 活动行画廊      | 进行中/回答结束后的过程线、任务清单行，以及每个工具族的四态活动行（⚙️/✅/❌/⏹️），全部由 `src/activity.ts` 真实渲染 |
| 设置            | replyMode、lifecycle、throttleMs、maxCardChars、会话类型、明暗主题、手机/桌面宽度                                   |

`壳标注` 默认关闭：打开后把钉钉客户端渲染、插件无法控制的元素（头像、卡片头、状态点、输入中三点、
失败红条、markdown 标题、时间条、表情回应）用虚线框圈出来，卡片正文永远不会被圈 ——
方便你判断"我改的是自己的 markdown，还是钉钉的壳"。对照关系见 [FIDELITY.md](FIDELITY.md)。

设置面板里的字段带「剧本默认 / 已手动覆盖」角标：**只有你手动改过的字段才会覆盖剧本默认值**，
所以在 `超长输出自动换卡` 剧本里改 `maxCardChars` 才有意义，不改就自动沿用剧本的 240。

### 两个容易踩的点

- **默认 `lifecycle: "finalize"`**：和插件当前默认一致 —— 卡片永远以定稿态刷新，没有「输入中」。
  想看原生「输入中」打字效果，把 lifecycle 切到 `stream`，此时中间帧的 `flowStatus` 才是 `inputing`。
- **表格前的空行**：钉钉不渲染紧贴段落的表格。`rich-final` 剧本故意把表格贴在列表后面，
  帧内容里会被自动补空行（在实验室里关掉「卡片规范化」即可复现坏样式）。

## 内置剧本

| id               | 看点                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `text-stream`    | 最短链路：思考 → 逐字正文 → 定稿                                    |
| `tool-run`       | 4 次工具调用 + 表格/代码块收尾，过程线一眼看到进度、定稿收起        |
| `process-block`  | 思考 1.2 秒 + 6 次工具调用：过程线跟着步骤刷新，定稿收起为摘要      |
| `stacked-output` | 多轮工具/输出交替：每段工具压成一行，输出整段跟在其后逐段堆叠       |
| `todo-run`       | 5 项任务清单边做边推进：任务行只显示进行中的那一项与（已完成/总数） |
| `rich-final`     | 群聊长答案，多级标题、对齐表格、代码块、链接                        |
| `rollover`       | `maxCardChars` 调小触发换卡，观察「输出继续，见下方新卡片」         |
| `interleave`     | 输出中途有新气泡插到卡片下方，旧卡定稿并换到下方新卡                |
| `fail`           | 工具报错 → 模型限流，卡片进入失败态并附分类中文提示                 |
| `interrupt`      | 用户打断，卡片就地冻结并追加「任务已打断」                          |
| `empty`          | 模型只有推理没有正文时的兜底文案                                    |
| `markdown-mode`  | 不走卡片，回合结束一次性推 markdown 消息                            |
| `plain-mode`     | `replyMode=text`，markdown 不渲染                                   |

### 加一个剧本

在 `playground/scenarios.mjs` 里追加一项即可，`script(ctx)` 里可以用：

```js
await ctx.reasoning('先想一下') // 驱动「正在分析请求」过程线
await ctx.text('正文…') // 按 4 字符切片流式 + 提交 assistant/message
await ctx.tool('bash', { command: 'pnpm test', description: '运行测试' }, { runMs: 600 })
await ctx.interleave({ type: 'text', text: '（插话）' }) // 模拟下方出现新气泡
await ctx.end({ kind: 'completed' }) // 或 ctx.abort() / ctx.error('429 …', 'rate_limited')
```

## HTTP API

完整契约见 [`CONTRACT.md`](./CONTRACT.md)，速查：

```bash
curl -s localhost:5188/api/scenarios
curl -s localhost:5188/api/run -H 'content-type: application/json' \
  -d '{"scenarioId":"tool-run","options":{"lifecycle":"stream","throttleMs":200}}'
curl -s localhost:5188/api/normalize -H 'content-type: application/json' \
  -d '{"text":"段落\n| a | b |\n| --- | --- |"}'
curl -s localhost:5188/api/activity-lines
```

`POST /api/run` 的返回就是一份可提交、可 diff 的录制：`timeline[]` 里每条 entry 都带相对时间 `t`。
想比较两次美化改动的差异，把两次响应存成 JSON 再 diff 即可。

## 仿真边界（别把它当钉钉客户端）

- **不模拟 A2UI**：审批/提问卡片（`src/a2ui.ts`）不在 v1 范围。
- **markdown 渲染是近似实现**：`public/markdown.js` 覆盖钉钉支持的 GFM 子集（标题/强调/行内代码/围栏代码/引用/列表/表格/链接/图片/分隔线），
  单换行按 `<br>` 处理。钉钉客户端的字体、行高、表格边框、图片裁切与真机存在像素级差异，最终观感仍需真机确认。
- **不模拟平台侧行为**：卡片 QPS 限流与重试、`Card.Streaming.Write` 权限失败后的 markdown 兜底、`[AILoading]` 占位、消息去重与撤回都不在仿真范围。
- **不模拟富媒体**：图片、文件、语音消息只有占位，不会真的上传。

### 渲染器明确不支持 / 尚未在真机验证的部分

下表是 `public/markdown.js` 的固定行为，属于「本地渲染器的选择」，不代表钉钉本身：

| 能力                                        | playground 行为                                                   |
| ------------------------------------------- | ----------------------------------------------------------------- |
| setext 标题（`标题` + `===`）               | 按段落 / `<hr>` 处理                                              |
| 4 空格缩进代码块                            | 按段落文字处理                                                    |
| 任务列表 `- [ ]`、脚注、数学公式、内联 HTML | 全部按纯文本                                                      |
| 列表嵌套                                    | 只建一层，更深缩进折叠为文本前导空格（不丢字）                    |
| 嵌套强调 `**a *b***`                        | 合法 HTML 但不完全等价（不丢字）                                  |
| 链接 label / URL 跨行                       | 不支持跨行，链接 `title` 丢弃                                     |
| 自动链接                                    | 只做 http/https；`www.`、裸域名、`tel:`、`dingtalk://` 都是纯文本 |

真机上仍需确认、且会影响美化判断的点（发现差异请回来改 `markdown.js` 和本文档）：

1. 表格的 `align="left|center|right"` 是否真的生效（若钉钉只认 `style="text-align:…"`，改渲染器一处即可）。
2. `<del>`、`<img>`、`<blockquote>`、`<pre><code class="language-x">` 在钉钉里的实际表现（是否保留、代码块是否自带边框）。
3. 「单换行 = 换行」在 **AI 卡片**与 **`sessionWebhook` markdown 消息**两条通道上是否一致。
4. 钉钉对 HTML 实体、中文与 emoji 的宽度与换行处理。

定位很明确：**在 playground 里把文案、排版、状态行、时序定下来，再用真机做最后一遍验收。**

哪部分是插件真实产出、哪部分只是钉钉客户端画的壳，看 [FIDELITY.md](FIDELITY.md)：
界面里的「壳标注」开关会把不可控的客户端壳用虚线框圈出来，避免把 CSS 改到别人身上。

## 测试

```bash
pnpm run build && node --experimental-test-module-mocks --test test/playground.test.mjs
node --test test/markdown.test.mjs
```

`test/playground.test.mjs` 校验录制的不变式：帧必须先创建卡片、定稿不能停在中间态、失败帧与失败态一致、
lifecycle 切换会改变 `flowStatus`、rollover 会产生第二张卡、非卡片模式不会创建卡片、HTTP 层错误码正确。

离线兜底数据可以重新生成（改了 renderer 或 `tool-run` 剧本之后跑一次）：

```bash
node playground/fixture.mjs                      # 默认 tool-run
node playground/fixture.mjs rollover             # 指定剧本
```

playground 本身就是回归工具：接入这条仿真的第一轮就抓到了 `src/renderer.ts` 的两处真实缺陷 ——
「插话后立刻收尾会把同一段正文重复写进两张卡」和「正文已全部流出后插话仍会加『输出继续』指针、再开一张重复卡」。
修复与回归用例见 `test/renderer-interleave-settle.test.mjs`。
