import assert from 'node:assert/strict'
import test from 'node:test'

import { Renderer } from '../lib/renderer.js'

function createHarness(options = {}) {
  const frames = []
  const finished = []
  const failed = []
  const sent = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const card = {
    async stream(content) {
      frames.push(content)
    },
    async finish(content) {
      // A real card finish is an HTTP round-trip; keep it configurable so tests
      // can inject events while the rollover await is in flight.
      if (options.finishDelayMs) await sleep(options.finishDelayMs)
      finished.push(content)
    },
    async fail(content) {
      failed.push(content)
    },
  }
  const renderer = new Renderer({
    config: {
      replyMode: { direct: options.mode ?? 'aicard', group: options.mode ?? 'aicard' },
      streaming: { enabled: true, throttleMs: 1, maxCardChars: options.maxCardChars ?? 20_000 },
      asyncMode: false,
      ackText: 'ack',
      markdownTitle: 'DSH',
      emotionFirstResponse: false,
    },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
      async sendText(_webhook, text) {
        sent.push(text)
        return true
      },
    },
    emotion: { async recall() {} },
    async createCard() {
      return card
    },
    log() {},
  })
  const msg = {
    msgId: 'm1',
    conversationId: 'c1',
    conversationType: 'direct',
    senderStaffId: 'u1',
    senderNick: 'Raph',
    text: '你好',
    createAt: '1',
    sessionWebhook: 'https://example.test',
  }
  const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    renderer,
    msg,
    frames,
    finished,
    failed,
    sent,
    tick,
    send: (event) => renderer.onSessionEvent({ id: 's1' }, event),
    text(text) {
      this.send({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } })
    },
    reasoning(text) {
      this.send({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text } } })
    },
    todos(items) {
      this.send({ type: 'todo/write', data: { todos: items } })
    },
    call(callId, name, args) {
      this.send({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
    },
    result(callId, options = {}) {
      const block = { type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }
      if (options.omitCallId !== true) block.toolCallId = callId
      if (options.isError) block.isError = true
      this.send({
        type: 'tool/result',
        data: {
          message: {
            content: [block],
            ...(options.omitCallId === true ? {} : { source: { kind: 'tool', callId } }),
          },
          ...(options.error !== undefined ? { error: options.error } : {}),
        },
      })
    },
    last() {
      return frames[frames.length - 1]
    },
    /** The first paragraph of a frame: the process line (or the answer). */
    processLine(content) {
      return content.split('\n\n')[0]
    },
  }
}

const EMPTY_WARNING = '⚠️ **模型本次未产出正文**\n> 可能是输出额度被推理占满，请调大 `max_tokens` 或更换模型后重试。'

test('工具步骤压成一行过程线，定稿后收起为摘要', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'npm test', description: '运行测试' })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在执行命令 运行测试')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 1 步：执行命令 运行测试')

  harness.call('c2', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在读取文件 src/a.ts · 已完成 1 步：执行命令 运行测试')

  harness.result('c2')
  harness.call('c3', 'grep', { pattern: 'TODO' })
  await harness.tick()
  harness.result('c3')
  await harness.tick()
  // One paragraph, one icon, no blockquote: the work log never costs a block.
  assert.equal(harness.last(), '⚙️ 已完成 3 步：读取文件 src/a.ts · 搜索 TODO 等')
  assert.doesNotMatch(harness.last(), /\n/)
  assert.doesNotMatch(harness.last(), /^> /)

  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()
  // 简洁 mode folds the work log: one header line above the answer.
  assert.equal(harness.finished.at(-1), `✅ 已完成 · 3 次工具调用\n\n${EMPTY_WARNING}`)
})

test('工具段与输出按发生顺序堆叠：工具一段一行，输出整段跟随', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.text('先看一下文件。')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。')

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  // Chronological: the work line of this burst sits BELOW the paragraph that
  // preceded it and ABOVE the paragraph it will produce.
  assert.equal(harness.last(), '先看一下文件。\n\n⚙️ 正在读取文件 src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。\n\n⚙️ 已完成 1 步：读取文件 src/a.ts')

  harness.text('我看完了。')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。\n\n⚙️ 已完成 1 步：读取文件 src/a.ts\n\n我看完了。')

  harness.call('c2', 'grep', { pattern: 'TODO' })
  await harness.tick()
  harness.result('c2')
  await harness.text('最后一段。')
  await harness.tick()
  // Second burst: same shape, stacked below the previous output.
  assert.equal(
    harness.last(),
    '先看一下文件。\n\n⚙️ 已完成 1 步：读取文件 src/a.ts\n\n我看完了。\n\n⚙️ 已完成 1 步：搜索 TODO\n\n最后一段。',
  )
})

test('思考与工具共用同一条过程线', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('嗯，先想想。')
  await harness.tick()
  assert.equal(harness.last(), '💭 正在分析请求')

  harness.call('c1', 'grep', { pattern: 'TODO' })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在搜索 TODO')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 1 步：搜索 TODO')
})

test('没有步骤可显示时，过程线用思考时长占位', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('先想想。')
  await harness.tick(1100)
  harness.text('想好了。')
  await harness.tick()

  assert.equal(harness.last(), '💭 已思考 1 秒\n\n想好了。')
})

test('旧调用的结果只更新它自己那条步骤', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.call('c2', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  // The newest call is the one in flight, even though c1 never returned.
  assert.equal(harness.last(), '⚙️ 正在读取文件 src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在读取文件 src/a.ts · 已完成 1 步：执行命令 列目录')

  harness.result('c2')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 2 步：执行命令 列目录 · 读取文件 src/a.ts')
})

test('任务清单只在有进行中的项时出现在过程线上方', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.todos([
    { content: '读一遍渲染器', status: 'completed' },
    { content: '把过程线压成一行', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
    { content: '更新文档', status: 'pending' },
    { content: '重新加载插件', status: 'pending' },
  ])
  await harness.tick()
  assert.equal(harness.last(), '📋 任务进行中：把过程线压成一行（1/5）')

  harness.call('c1', 'read', { file_path: 'src/renderer.ts' })
  await harness.tick()
  // Task line above the process line, one blank line apart: two paragraphs.
  assert.equal(harness.last(), '📋 任务进行中：把过程线压成一行（1/5）\n\n⚙️ 正在读取文件 src/renderer.ts')

  harness.todos([
    { content: '读一遍渲染器', status: 'completed' },
    { content: '把过程线压成一行', status: 'completed' },
    { content: '补测试', status: 'in_progress' },
  ])
  await harness.tick()
  assert.equal(harness.last(), '📋 任务进行中：补测试（2/3）\n\n⚙️ 正在读取文件 src/renderer.ts')

  // Nothing in flight: the line disappears instead of showing a stale task.
  harness.todos([
    { content: '读一遍渲染器', status: 'completed' },
    { content: '补测试', status: 'completed' },
  ])
  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 1 步：读取文件 src/renderer.ts')

  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()
  // The settled card folds to the work header only; the task list belongs to the
  // turn that produced it.
  assert.equal(harness.finished.at(-1), `✅ 已完成 · 1 次工具调用\n\n${EMPTY_WARNING}`)
})

test('失败与打断标记在面包屑里', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  harness.result('c1', { isError: true })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 1 步：读取文件失败 src/a.ts')

  harness.call('c2', 'bash', { command: 'sleep 10', description: '等待' })
  harness.result('c2', { isError: true, error: { name: 'InterruptedError', code: 'interrupted' } })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 2 步：读取文件失败 src/a.ts · 执行命令中断 等待')
})

test('定稿时过程线收起，正文保留', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('先想想。')
  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  harness.result('c1')
  harness.send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答案' }] } } })
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.deepEqual(harness.finished, ['✅ 已完成 · 1 次工具调用\n\n最终答案'])
})

test('没有正文时定稿保留摘要行并提示空响应', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], `✅ 已完成 · 1 次工具调用\n\n${EMPTY_WARNING}`)
})

test('打断时把过程收起成一行「任务已打断」，不再额外补一句', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '⏹️ 任务已打断 · 1 次工具调用')
})

test('面包屑只留最近 2 步，更早的用「等」收口', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  for (let i = 0; i < 5; i++) {
    harness.call(`c${i}`, 'read', { file_path: `src/${i}.ts` })
    harness.result(`c${i}`)
    await harness.tick(8)
  }

  assert.equal(harness.last(), '⚙️ 已完成 5 步：读取文件 src/3.ts · 读取文件 src/4.ts 等')
})

test('超长滚动后新卡承接过程线与未定稿正文，旧卡不重复状态', async () => {
  const harness = createHarness({ maxCardChars: 45 })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('A'.repeat(50))
  await harness.tick()
  // First card settled with the whole text and rolled over to a new card.
  assert.equal(harness.finished.length, 1)
  assert.match(harness.finished[0], /输出继续，见下方新卡片/)

  harness.text('B')
  await harness.tick()
  assert.equal(harness.last(), 'B')

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  assert.equal(harness.last(), 'B\n\n⚙️ 正在读取文件 src/a.ts')
  assert.doesNotMatch(harness.last(), /A{2}/)

  harness.result('c1')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()
  assert.equal(harness.finished.at(-1), 'B\n\n✅ 已完成 · 1 次工具调用')
})

test('PTC 模式下的嵌套调用共用一条过程线', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.send({
    type: 'tool/call',
    data: { callId: 'root', name: 'run_code', arguments: '{"description":"执行脚本"}' },
  })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在运行代码 执行脚本')

  harness.send({
    type: 'tool/ptc-dispatch-start',
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId: 'root:ptc:1',
      name: 'bash',
      arguments: { command: 'ls', description: '列目录' },
    },
  })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在执行命令 列目录')

  harness.send({
    type: 'tool/ptc-dispatch',
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId: 'root:ptc:1',
      name: 'bash',
      arguments: { command: 'ls' },
      isError: false,
      content: [],
    },
  })
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 正在运行代码 执行脚本 · 已完成 1 步：执行命令 列目录')
})

test('滚动期间到达的正文不会丢失', async () => {
  const harness = createHarness({ maxCardChars: 45, finishDelayMs: 40 })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('A'.repeat(50))
  await harness.tick(10) // rollover started; finish RPC still in flight
  harness.text('DURING-ROLLOVER')
  await harness.tick(120)

  assert.ok(harness.frames.includes('DURING-ROLLOVER'), 'the new card must receive the concurrent chunk')

  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick(80)
  assert.equal(harness.finished.at(-1), 'DURING-ROLLOVER')
})

test('仅推理无正文时仍给出空响应警告', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('预算全花在推理上了。')
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.match(harness.finished[0], /模型本次未产出正文/)
  assert.doesNotMatch(harness.finished[0], /正在分析请求/)
})

test('打断的纯推理回合不把思考占位写进卡片', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('先想想。')
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '⏹️ 任务已打断')
})

test('插话换卡时旧卡只留正文，过程线随新卡重建', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }] } } })
  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '第一段\n\n⚙️ 已完成 1 步：执行命令 列目录')

  harness.renderer.notifyInterleaved('c1')
  harness.call('c2', 'read', { file_path: 'src/a.ts' })
  await harness.tick()

  // The settled card keeps the stable text only; the work log belongs to the
  // live card below it.
  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '第一段\n\n⚙️ 已完成 1 步：执行命令 列目录\n\n> ⤵️ 输出继续，见下方新卡片')
  assert.match(harness.last(), /正在读取文件/)

  harness.result('c2')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await harness.tick()

  assert.equal(harness.finished.length, 2)
  assert.equal(harness.finished[1], '✅ 已完成 · 2 次工具调用')
})

test('缺少 callId 的结果不会误判最新调用', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  harness.result('c1', { omitCallId: true })
  await harness.tick()

  assert.equal(harness.last(), '⚙️ 正在读取文件 src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '⚙️ 已完成 1 步：读取文件 src/a.ts')
})

test('markdown/text 降级模式输出同样的过程线', async () => {
  const harness = createHarness({ mode: 'text' })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.deepEqual(harness.sent, [`✅ 已完成 · 1 次工具调用\n\n${EMPTY_WARNING}`])
})

test('滚动后打断只在新卡补结束提示，不重复旧卡正文', async () => {
  const harness = createHarness({ maxCardChars: 45, finishDelayMs: 10 })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('A'.repeat(50))
  await harness.tick(60)
  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await settled
  await harness.tick(60)

  assert.equal(harness.finished.length, 2)
  assert.equal(harness.finished[1], '⏹️ 任务已打断 · 1 次工具调用')
  assert.doesNotMatch(harness.finished[1], /AAAA/)
})
