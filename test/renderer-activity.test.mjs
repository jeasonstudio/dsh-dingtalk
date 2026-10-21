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
  }
}

function activityLines(content) {
  return content.split('\n').filter((line) => line.startsWith('> '))
}

test('连续工具调用只保留最新一行，不累积历史', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  const calls = [
    ['c1', 'bash', { command: 'npm test', description: '运行测试' }, '正在执行命令', '已执行命令'],
    ['c2', 'read', { file_path: 'src/a.ts' }, '正在读取文件', '已读取文件'],
    ['c3', 'write', { file_path: 'src/b.ts', content: 'x' }, '正在写入文件', '已写入文件'],
    ['c4', 'grep', { pattern: 'TODO' }, '正在搜索', '已搜索'],
  ]

  for (const [callId, name, args, running, done] of calls) {
    harness.call(callId, name, args)
    await harness.tick()
    assert.match(harness.last(), new RegExp(running))
    assert.equal(activityLines(harness.last()).length, 1)

    harness.result(callId)
    await harness.tick()
    assert.match(harness.last(), new RegExp(done))
    assert.equal(activityLines(harness.last()).length, 1)
  }

  // The last frame is the DONE state of the last call only — no earlier row.
  assert.equal(harness.last(), '> ✅ 已搜索 · TODO')

  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
})

test('文本与工具交替时，状态行只跟在最新位置，段落不粘连', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.text('先看一下文件。')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。')

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。\n\n> ⚙️ 正在读取文件 · src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。\n\n> ✅ 已读取文件 · src/a.ts')

  harness.text('我看完了。')
  await harness.tick()
  assert.equal(harness.last(), '先看一下文件。\n\n我看完了。')
})

test('思考中与工具调用共享同一条状态行', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('嗯，先想想。')
  await harness.tick()
  assert.equal(harness.last(), '> 💭 正在思考…')

  harness.call('c1', 'grep', { pattern: 'TODO' })
  await harness.tick()
  assert.equal(harness.last(), '> ⚙️ 正在搜索 · TODO')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '> ✅ 已搜索 · TODO')
})

test('旧调用的结果不会覆盖正在运行的新调用', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.call('c2', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  assert.equal(harness.last(), '> ⚙️ 正在读取文件 · src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '> ⚙️ 正在读取文件 · src/a.ts')

  harness.result('c2')
  await harness.tick()
  assert.equal(harness.last(), '> ✅ 已读取文件 · src/a.ts')
})

test('失败与打断使用 ❌ / ⏹️ 状态文案', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  harness.result('c1', { isError: true })
  await harness.tick()
  assert.equal(harness.last(), '> ❌ 读取文件失败 · src/a.ts')

  harness.call('c2', 'bash', { command: 'sleep 10', description: '等待' })
  harness.result('c2', { isError: true, error: { name: 'InterruptedError', code: 'interrupted' } })
  await harness.tick()
  assert.equal(harness.last(), '> ⏹️ 执行命令已停止 · 等待')
})

test('定稿时正文替换实时状态行', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.reasoning('先想想。')
  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  harness.send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答案' }] } } })
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.deepEqual(harness.finished, ['最终答案'])
})

test('没有正文时定稿只保留最新一行状态', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '> ✅ 已执行命令 · 列目录')
})

test('打断时在状态行下补一句结束提示', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await settled
  await harness.tick()

  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '> ⚙️ 正在读取文件 · src/a.ts\n\n⏹️ 任务已打断')
})

test('超长滚动后新卡只承接未定稿的文本，状态行不破坏偏移', async () => {
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
  assert.equal(harness.last(), 'B\n\n> ⚙️ 正在读取文件 · src/a.ts')
  assert.doesNotMatch(harness.last(), /A/)

  harness.result('c1')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()
  assert.equal(harness.finished.at(-1), 'B\n\n> ✅ 已读取文件 · src/a.ts')
})

test('PTC 模式下的嵌套工具调用复用同一条状态行', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.send({
    type: 'tool/call',
    data: { callId: 'root', name: 'run_code', arguments: '{"description":"执行脚本"}' },
  })
  await harness.tick()
  assert.equal(harness.last(), '> ⚙️ 正在运行代码 · 执行脚本')

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
  assert.equal(harness.last(), '> ⚙️ 正在执行命令 · 列目录')

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
  assert.equal(harness.last(), '> ✅ 已执行命令 · 列目录')
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
  assert.doesNotMatch(harness.finished[0], /正在思考/)
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

test('滚动时状态行不冻结在旧卡，也不在新卡重复', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '第一段\n\n> ✅ 已执行命令 · 列目录')

  harness.renderer.notifyInterleaved('c1')
  harness.call('c2', 'read', { file_path: 'src/a.ts' })
  await harness.tick()

  // The settled card keeps the stable text only; the live status belongs to
  // the new card below it.
  assert.equal(harness.finished.length, 1)
  assert.equal(harness.finished[0], '第一段\n\n> ⤵️ 输出继续，见下方新卡片')
  assert.match(harness.last(), /正在读取文件/)

  harness.result('c2')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await harness.tick()

  assert.equal(harness.finished.length, 2)
  assert.equal(harness.finished[1], '> ✅ 已读取文件 · src/a.ts')
  assert.equal(harness.finished.filter((content) => content.includes('已读取文件')).length, 1)
})

test('缺少 callId 的结果不会误判最新调用', async () => {
  const harness = createHarness()
  harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'read', { file_path: 'src/a.ts' })
  await harness.tick()
  harness.result('c1', { omitCallId: true })
  await harness.tick()

  assert.equal(harness.last(), '> ⚙️ 正在读取文件 · src/a.ts')

  harness.result('c1')
  await harness.tick()
  assert.equal(harness.last(), '> ✅ 已读取文件 · src/a.ts')
})

test('markdown/text 降级模式同样只输出最新一行状态', async () => {
  const harness = createHarness({ mode: 'text' })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.call('c1', 'bash', { command: 'ls', description: '列目录' })
  harness.result('c1')
  harness.send({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await harness.tick()

  assert.deepEqual(harness.sent, ['> ✅ 已执行命令 · 列目录'])
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
  assert.equal(harness.finished[1], '> ⚙️ 正在读取文件 · src/a.ts\n\n⏹️ 任务已打断')
  assert.doesNotMatch(harness.finished[1], /AAAA/)
})
