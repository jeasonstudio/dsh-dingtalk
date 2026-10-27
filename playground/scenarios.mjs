/**
 * Playground scenarios: realistic DSH turns replayed against the real renderer.
 *
 * A script is `async (ctx) => ...`; `ctx` emits host session events and waits in
 * real time, so the recorded timeline carries the same ordering and throttle
 * behaviour as a live turn. Add a scenario here and it shows up in the sidebar.
 */

const markdownAnswer = `## 结论

先把 **流式帧** 和 **定稿帧** 分开处理：卡片按执行顺序堆叠，每段工具压成一行，输出整段跟在后面，定稿时最后一行折成摘要。

### 改动点

1. \`activity.ts\` 把步骤压成「当前 + 最近 3 步 + 用时」的一行
2. \`aicard.ts\` 写入前补齐表格前的空行
3. \`renderer.ts\` 的 rollover 按块切分，旧卡只保留已展示的内容
| 文件 | 行数 | 风险 | 说明 |
| --- | ---: | :---: | --- |
| \`src/activity.ts\` | 227 | 低 | 纯展示层 |
| \`src/aicard.ts\` | 297 | 中 | 帧规范化 |
| \`src/renderer.ts\` | 462 | 中 | 时序与回滚 |

> 每段过程线只占一个段落，不额外占用引用块

\`\`\`ts
const line = renderProcessLine(snapshot)
// ⚙️ 正在执行命令 pnpm run ci · 已完成 2 步：读取文件 src/a.ts · 搜索 TODO
\`\`\`

细节见 [卡片流式文档](https://open.dingtalk.com/document/orgapp/streaming-card)，或者直接看 \`docs/a2ui-interactions.md\`。`

const longBody = `## 排查过程

先确认三件事：**Stream 连接是否还在**、**会话映射有没有串**、**卡片权限是否被拒**。

- 连接层：\`dingtalk-stream\` 断线后会自动重连，但重连期间的消息会丢，需要在 intake 侧去重
- 会话层：一个群多个话题要各自映射 Session，不能共用
- 卡片层：缺少 \`Card.Streaming.Write\` 时应该静默降级成 markdown，而不是把错误抛给用户

### 为什么不能共用 Session

同一个群里两个话题的上下文完全不同。如果共用，A 话题里提到的文件路径会被 B 话题的模型看见，轻则答非所问，重则把无关内容发到另一个话题里。

所以映射键必须包含 \`openConversationId\` + 话题标识，且写进 \`bindings.json\` 前要做一次规范化，避免大小写差异导致双写。`

export const scenarios = [
  {
    id: 'text-stream',
    title: '纯文本流式回答',
    description: '最简单的一条链路：思考 → 逐字正文 → 定稿。用来看打字机节奏和段落间距。',
    tags: ['基础', '流式'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '这个项目支持群聊吗？' },
    async script(ctx) {
      await ctx.reasoning('用户问的是群聊支持，先确认白名单和 @ 机制。', { delay: 90 })
      await ctx.text(
        '支持。群聊里需要 **先 @ 机器人**，再写正文；机器人只处理 @ 它的消息。\n\n- 群白名单在 `/config` 里配置\n- 未授权群会静默拒绝，不会回包\n- 群里默认按 `openConversationId` 区分会话',
        { delay: 18 },
      )
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'tool-run',
    title: '多工具推进 + 富文本收尾',
    description:
      '思考 → 4 次工具调用（命令/搜索/读/写）→ 表格与代码块收尾。重点看每段工具压成一行、输出整段堆在它下面、定稿后最后一行收成摘要。',
    tags: ['工具行', '富文本'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '帮我把流式说明补进 README，然后跑一遍门禁' },
    async script(ctx) {
      await ctx.reasoning('先看 README 现状，再补流式一节，最后跑 ci。', { delay: 80 })
      await ctx.text('我先看一下 README 里流式相关的段落。', { delay: 22 })
      await ctx.tool('grep', { pattern: '流式|streaming', path: 'README.zh-CN.md' }, { runMs: 420 })
      await ctx.tool('read', { file_path: 'README.zh-CN.md' }, { runMs: 380 })
      await ctx.text('找到了三处需要改的地方，我补一节「流式输出」，然后跑门禁。', { delay: 20 })
      await ctx.tool('edit', { file_path: 'README.zh-CN.md' }, { runMs: 520 })
      await ctx.tool('bash', { command: 'pnpm run ci', description: '运行完整门禁' }, { runMs: 900 })
      await ctx.text(markdownAnswer, { delay: 14 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'process-block',
    title: '过程线：多步骤一眼看完',
    description:
      '思考 1.2 秒 → 6 次工具调用（读/搜/跑/改）→ 正文。进度压成一行：当前步骤 + 最近 3 步 + 用时，定稿后收起成「已完成 · N 次工具调用 · 用时 X」，不占额外纵向空间。',
    tags: ['过程线', '工具行'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '把插件安装到我的 dsh 环境，然后跑一遍门禁' },
    async script(ctx) {
      await ctx.reasoning('先看仓库结构和安装脚本，再改 bundle，最后跑 ci。', { delay: 1200 })
      await ctx.text('我先确认一下当前仓库的结构和安装脚本。', { delay: 18 })
      await ctx.tool('read', { file_path: 'package.json' }, { runMs: 260 })
      await ctx.tool('grep', { query: 'install_bundle|profiles' }, { runMs: 300 })
      await ctx.tool('bash', { command: 'node bin/install.mjs --dry-run', description: '试跑安装脚本' }, { runMs: 520 })
      await ctx.tool('edit', { file_path: 'bin/install.mjs' }, { runMs: 380 })
      await ctx.tool('bash', { command: 'pnpm run build', description: '构建产物' }, { runMs: 700 })
      await ctx.tool('bash', { command: 'pnpm run ci', description: '运行完整门禁' }, { runMs: 900 })
      await ctx.text(
        '已经把它装进当前 dsh 环境了，原有配置一个字没动：\n\n- bundle 列表里只把 dingtalk 换成本地构建\n- `cordis.patch.yml` 与备份逐字节一致\n- 门禁通过，全部测试转绿',
        { delay: 14 },
      )
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'stacked-output',
    title: '多轮输出：工具一段、输出一段往上堆',
    description:
      '工具/思考 → 一段输出 → 再工具 → 再输出，最后一段是最终答案。每个工具段压成一行，输出整段跟在它后面，卡片像一份执行记录，直到最终输出。',
    tags: ['过程线', '多段输出'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '把插件装到我本地 dsh，装完告诉我改了哪些文件' },
    async script(ctx) {
      await ctx.reasoning('先摸底，再改，最后跑门禁。', { delay: 900 })
      await ctx.tool('read', { file_path: 'package.json' }, { runMs: 240 })
      await ctx.tool('grep', { query: 'install_bundle|profiles' }, { runMs: 280 })
      await ctx.text('现在的情况：bundle 列表里还是官方版本，`cordis.patch.yml` 没动过。我先改安装脚本。')
      await ctx.tool('edit', { file_path: 'bin/install.mjs' }, { runMs: 420 })
      await ctx.text('安装脚本改好了：优先读本地 link，找不到再回落到 npm 版本。')
      await ctx.tool('bash', { command: 'node bin/install.mjs --dry-run', description: '试跑安装脚本' }, { runMs: 520 })
      await ctx.tool('bash', { command: 'pnpm run ci', description: '运行完整门禁' }, { runMs: 900 })
      await ctx.text(
        '跑完了。最终结论：\n\n- bundle 只把 dingtalk 换成本地构建\n- `cordis.patch.yml` 与备份逐字节一致\n- 门禁通过，520 个用例全绿',
        { delay: 14 },
      )
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'todo-run',
    title: '带任务清单：进行中的那一项',
    description:
      'todo_write 建 5 项清单，边做边推进状态。卡片最上方多一行「📋 任务进行中：xxxxx（1/5）」，只有进行中的那一项，定稿后收起。',
    tags: ['任务清单', '过程线'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '按任务清单改一下卡片的换行兼容' },
    async script(ctx) {
      const list = (activeIndex, done = activeIndex) =>
        ['改 activity.ts', '改 renderer.ts', '补真机回归用例', '更新 FIDELITY', '重载插件'].map((content, index) => ({
          content,
          status: index < done ? 'completed' : index === activeIndex ? 'in_progress' : 'pending',
        }))

      await ctx.reasoning('这是多步任务，先建清单再一步步做。', { delay: 700 })
      await ctx.text('先把任务拆开，按顺序改。', { delay: 16 })
      await ctx.todos(list(0))
      await ctx.tool('read', { file_path: 'src/activity.ts' }, { runMs: 320 })
      await ctx.todos(list(1))
      await ctx.tool('edit', { file_path: 'src/activity.ts' }, { runMs: 380 })
      await ctx.todos(list(2))
      await ctx.tool('edit', { file_path: 'src/renderer.ts' }, { runMs: 420 })
      await ctx.todos(list(3))
      await ctx.tool('bash', { command: 'pnpm run test', description: '运行测试' }, { runMs: 700 })
      await ctx.todos(list(4, 3))
      await ctx.text(
        '改完了：每段过程线仍然只占一段，任务清单只额外多一行「进行中」。\n\n- `activity.ts` 加任务行\n- `renderer.ts` 在帧里拼上任务行\n- 回归用例锁住「只显示进行中」',
        { delay: 14 },
      )
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'rich-final',
    title: '一次性富文本答案（群聊）',
    description: '群聊场景下的长答案：多级标题、带对齐的表格、代码块、引用、链接。表格紧贴段落，用来验证空行补齐。',
    tags: ['排版', '群聊'],
    defaults: { replyMode: 'aicard', conversationType: 'group' },
    conversationTitle: '前端体验打磨(12)',
    user: { nick: '牧曈', text: '@DSH 助手 帮我评审下这份卡片渲染方案' },
    async script(ctx) {
      await ctx.reasoning('评审请求，直接给结论 + 风险点 + 建议。', { delay: 60 })
      await ctx.text(markdownAnswer, { delay: 12 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'rollover',
    title: '超长输出自动换卡',
    description: '把 maxCardChars 调小（默认 240）触发定稿 + 新卡续写，观察「输出继续，见下方新卡片」指针与偏移。',
    tags: ['rollover', '边界'],
    defaults: { maxCardChars: 240 },
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '把排查过程完整讲一遍' },
    async script(ctx) {
      await ctx.reasoning('这个问题比较长，分三段讲。', { delay: 60 })
      await ctx.text(longBody, { delay: 10 })
      await ctx.text('### 建议\n\n一次只改一个维度，改完立刻跑一次真实群聊验证。', { delay: 12 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'interleave',
    title: '输出中途有新气泡插话',
    description:
      '另一条消息落在卡片下方：旧卡就地定稿并加「输出继续」指针，剩余正文落到下方新卡，不会重复。群聊里很常见。',
    tags: ['rollover', '群聊'],
    conversationTitle: '前端体验打磨(12)',
    defaults: { conversationType: 'group' },
    user: { nick: '牧曈', text: '帮我总结下今天讨论的结论' },
    async script(ctx) {
      await ctx.reasoning('先输出前半段，等插话再继续。', { delay: 60 })
      await ctx.text('今天的结论有三条：\n\n1. 卡片正文统一走 `renderer.ts`\n2. 过程块只保留最近 6 步', { delay: 16 })
      // Wait out the throttle so the first paragraph is really on screen before
      // the conversation interrupts: that is what forces the roll-over.
      await ctx.wait(700)
      await ctx.interleave({ type: 'markdown', title: '另一个机器人', text: '补充一句：徽章的动画别超过 200ms。' })
      await ctx.text('3. 表格前必须补空行，否则钉钉不渲染', { delay: 14 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'fail',
    title: '工具失败 + 回合报错',
    description: '工具报错后模型再次限流，卡片进入失败态并附上分类后的中文提示。用来检查 ❌ / ⚠️ 的观感。',
    tags: ['失败态'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '跑一下测试' },
    async script(ctx) {
      await ctx.reasoning('先跑测试。', { delay: 50 })
      await ctx.tool(
        'bash',
        { command: 'pnpm test', description: '运行测试' },
        {
          runMs: 500,
          isError: true,
          error: { code: 'tool_error' },
        },
      )
      await ctx.text('测试失败了，我重试一次。', { delay: 18 })
      await ctx.wait(200)
      await ctx.error('模型调用失败：429 Too Many Requests', 'rate_limited')
    },
  },
  {
    id: 'interrupt',
    title: '任务被用户打断',
    description: '中途取消：卡片就地冻结并追加「任务已打断」，不会再多长出一张空卡。',
    tags: ['打断', '边界'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '把所有文件都改一遍' },
    async script(ctx) {
      await ctx.tool('bash', { command: 'rg TODO src', description: '搜索待办' }, { runMs: 400 })
      await ctx.text('我先从 `src/index.ts` 开始，第一处是', { delay: 24 })
      await ctx.wait(180)
      await ctx.abort()
    },
  },
  {
    id: 'empty',
    title: '模型没有产出正文',
    description: '只有推理没有正文时的兜底文案，避免出现空气泡。',
    tags: ['边界'],
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '用一句话解释 ACL' },
    async script(ctx) {
      await ctx.reasoning('想一下 ACL 的准确定义……', { delay: 220 })
      await ctx.reasoning('不要写偏了……', { delay: 180 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'markdown-mode',
    title: '非卡片兜底（markdown 消息）',
    description: 'replyMode=markdown 时没有流式卡片，回合结束一次性推送 markdown 消息。用来对比两条链路的观感差异。',
    tags: ['兜底', 'markdown'],
    defaults: { replyMode: 'markdown' },
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '介绍一下这个插件的回复载体' },
    async script(ctx) {
      await ctx.reasoning('解释三种载体。', { delay: 50 })
      await ctx.text(markdownAnswer, { delay: 10 })
      await ctx.end({ kind: 'completed' })
    },
  },
  {
    id: 'plain-mode',
    title: '纯文本兜底（text 消息）',
    description: 'replyMode=text 时不渲染 markdown，换行和符号原样保留。群聊里需要 @ 其他机器人时常用。',
    tags: ['兜底', 'text'],
    defaults: { replyMode: 'text' },
    conversationTitle: 'DSH 助手',
    user: { nick: '牧曈', text: '用纯文本回我一句' },
    async script(ctx) {
      await ctx.text('好的，这条是纯文本回复。\n\n**这行不会加粗**，`这行也不是代码`。', { delay: 14 })
      await ctx.end({ kind: 'completed' })
    },
  },
]
