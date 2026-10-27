/**
 * Playground contract tests: the recording the browser replays must stay a
 * faithful, self-consistent description of what the renderer sent.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PlaygroundInputError,
  activityLines,
  listScenarios,
  normalizeMarkdown,
  runScenario,
} from '../playground/runner.mjs'
import { createPlaygroundServer } from '../playground/server.mjs'
import { cardFrameContent } from '../lib/aicard.js'

const FAST = { pace: 0.05 }
const FLOW_STATUSES = new Set(['inputing', 'finished', 'failed'])
const FRAME_KINDS = new Set(['stream', 'finish', 'fail', 'update'])

test('scenario list is addressable and complete', () => {
  const scenarios = listScenarios()
  assert.ok(scenarios.length >= 8)
  assert.equal(new Set(scenarios.map((item) => item.id)).size, scenarios.length)
  for (const scenario of scenarios) {
    assert.ok(scenario.title && scenario.description, `${scenario.id} needs copy`)
    assert.ok(['aicard', 'markdown', 'text'].includes(scenario.mode))
    assert.ok(['direct', 'group'].includes(scenario.conversationType))
    assert.equal(scenario.conversationTitle.length > 0, true)
    // The UI seeds its settings panel from `defaults`, so they must be complete.
    assert.deepEqual(Object.keys(scenario.defaults).sort(), [
      'conversationType',
      'lifecycle',
      'maxCardChars',
      'replyMode',
      'throttleMs',
    ])
    assert.equal(scenario.defaults.replyMode, scenario.mode)
    assert.equal(scenario.defaults.conversationType, scenario.conversationType)
  }
})

test('every scenario records a self-consistent timeline', async () => {
  for (const scenario of listScenarios()) {
    const result = await runScenario(scenario.id, FAST)
    assert.ok(result.timeline.length > 0, `${scenario.id} recorded nothing`)

    let previousT = -1
    const created = new Set()
    for (const entry of result.timeline) {
      assert.ok(Number.isInteger(entry.t), `${scenario.id} entry needs integer t`)
      assert.ok(entry.t >= previousT, `${scenario.id} timeline must not go back in time`)
      previousT = entry.t
      if (entry.type === 'card-create') created.add(entry.cardId)
      if (entry.type === 'card-frame') {
        assert.ok(created.has(entry.cardId), `${scenario.id} frame before card-create: ${entry.cardId}`)
        assert.ok(FLOW_STATUSES.has(entry.flowStatus), `${scenario.id} bad flowStatus ${entry.flowStatus}`)
        assert.ok(FRAME_KINDS.has(entry.kind), `${scenario.id} bad frame kind ${entry.kind}`)
        assert.equal(entry.content.includes('\r'), false, `${scenario.id} frames must be LF-normalized`)
        if (entry.kind === 'fail') assert.equal(entry.flowStatus, 'failed')
        else assert.notEqual(entry.flowStatus, 'failed')
      }
    }

    const lastFrame = [...result.timeline].reverse().find((entry) => entry.type === 'card-frame')
    if (scenario.mode === 'aicard') {
      assert.ok(created.size > 0, `${scenario.id} should create at least one card`)
      assert.ok(lastFrame, `${scenario.id} should record a final card frame`)
      assert.ok(['finished', 'failed'].includes(lastFrame.flowStatus), `${scenario.id} card left mid-stream`)
      assert.ok(lastFrame.content.trim().length > 0, `${scenario.id} settled an empty card`)
    } else {
      assert.equal(created.size, 0, `${scenario.id} must not create a card in ${scenario.mode} mode`)
      const pushed = result.timeline.some((entry) => entry.type === scenario.mode)
      assert.ok(pushed, `${scenario.id} should push a ${scenario.mode} message`)
    }
  }
})

test('a failing turn settles the card as failed with classified text', async () => {
  const result = await runScenario('fail', FAST)
  const lastFrame = [...result.timeline].reverse().find((entry) => entry.type === 'card-frame')
  assert.equal(lastFrame.flowStatus, 'failed')
  assert.match(lastFrame.content, /限流|429/)
})

test('lifecycle switches the flow status of live frames', async () => {
  const streamed = await runScenario('text-stream', { ...FAST, lifecycle: 'stream' })
  const settled = await runScenario('text-stream', { ...FAST, lifecycle: 'finalize' })
  const statuses = (result) =>
    result.timeline.filter((entry) => entry.type === 'card-frame' && entry.kind === 'stream').map((e) => e.flowStatus)
  assert.ok(statuses(streamed).includes('inputing'), 'stream lifecycle should enter 输入中')
  assert.deepEqual(
    statuses(settled),
    statuses(settled).map(() => 'finished'),
  )
  assert.equal(settled.options.lifecycle, 'finalize')
})

test('录制的每一帧都是钉钉会原样收到的字节', async () => {
  for (const scenario of listScenarios()) {
    const result = await runScenario(scenario.id, FAST)
    for (const entry of result.timeline) {
      if (entry.type !== 'card-frame') continue
      // The payload builder is idempotent, so re-running it over a recorded
      // frame must be a no-op: if it is not, the page would show markdown that
      // DingTalk would still rewrite before rendering.
      assert.equal(cardFrameContent(entry.content, true), entry.content, `${scenario.id} frame drifted`)
      assert.equal(cardFrameContent(entry.content, false), entry.content, `${scenario.id} frame drifted`)
    }
  }
})

test('over-length output rolls over to a second card', async () => {
  const result = await runScenario('rollover', FAST)
  assert.ok(result.stats.cards >= 2, 'expected a rollover card')
  const firstFinish = result.timeline.find((entry) => entry.type === 'card-frame' && entry.kind === 'finish')
  assert.match(firstFinish.content, /输出继续，见下方新卡片/)
})

test('markdown mode falls back to one markdown message', async () => {
  const result = await runScenario('markdown-mode', FAST)
  const messages = result.timeline.filter((entry) => entry.type === 'markdown')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].title.length > 0, true)
  assert.equal(
    result.timeline.some((entry) => entry.type === 'text'),
    false,
  )
})

test('unknown scenarios and invalid options are rejected', async () => {
  await assert.rejects(runScenario('does-not-exist', FAST), (error) => {
    assert.ok(error instanceof PlaygroundInputError)
    assert.equal(error.code, 'unknown_scenario')
    assert.equal(error.status, 404)
    return true
  })
  await assert.rejects(runScenario('text-stream', { ...FAST, lifecycle: 'typing' }), (error) => {
    assert.equal(error.code, 'invalid_option')
    assert.equal(error.field, 'lifecycle')
    return true
  })
})

test('normalize explains the table blank-line fix', () => {
  const raw = '先看结论\n| a | b |\n| --- | --- |\n| 1 | 2 |'
  const fixed = normalizeMarkdown(raw)
  assert.equal(fixed.changed, true)
  assert.match(fixed.output, /先看结论\n\n\| a \| b \|/)
  assert.equal(fixed.notes.length, 1)
  assert.equal(normalizeMarkdown(raw, { normalize: false }).changed, false)
  assert.equal(normalizeMarkdown('').changed, false)
})

test('activity gallery renders through the real activity module', () => {
  const gallery = activityLines()
  assert.equal(gallery.thinking, '> 💭 正在分析请求')
  assert.match(
    gallery.process.line,
    /^⚙️ 正在执行命令 运行完整门禁 · 已完成 2 步：/,
    'live line shows the step in flight',
  )
  assert.match(gallery.process.thinking, /^💭 正在分析请求/)
  assert.match(gallery.process.todo, /^📋 任务进行中：.+（\d+\/\d+）$/, 'todo sample shows the item in flight')
  assert.match(gallery.process.settled, /^✅ 已完成 · \d+ 次工具调用 · 用时 /)
  assert.match(gallery.process.failed, /^❌ 处理失败/)
  for (const text of Object.values(gallery.process)) {
    assert.doesNotMatch(text, /\n/, 'the process line must stay one paragraph')
    assert.doesNotMatch(text, /^> /, 'the process line must not be a blockquote')
  }
  assert.ok(gallery.groups.length >= 10)
  for (const group of gallery.groups) {
    for (const [state, line] of Object.entries(group.lines)) {
      assert.equal(line.split('\n').length, 1, `${group.variant}/${state} must be one blockquote line`)
      assert.ok(line.startsWith('> '), `${group.variant}/${state} must be quoted: ${line}`)
    }
  }
  const bash = gallery.groups.find((group) => group.variant === 'bash')
  assert.match(bash.lines.running, /正在执行命令 · 运行完整门禁/)
})

test('http api serves scenarios, runs, normalization and static assets', async () => {
  const server = createPlaygroundServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, headers = { 'content-type': 'application/json' }) =>
    fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    const scenarios = await (await fetch(`${base}/api/scenarios`)).json()
    assert.ok(scenarios.scenarios.length >= 8)

    const run = await (await post('/api/run', { scenarioId: 'text-stream', options: FAST })).json()
    assert.ok(run.timeline.length > 0)
    assert.equal(run.conversation.user.nick.length > 0, true)

    const unknown = await post('/api/run', { scenarioId: 'nope' })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error, 'unknown_scenario')

    const invalid = await post('/api/run', { scenarioId: 'text-stream', options: { replyMode: 'hologram' } })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).field, 'replyMode')

    const noJson = await post('/api/run', '{"scenarioId":"text-stream"}', { 'content-type': 'text/plain' })
    assert.equal(noJson.status, 415)

    const normalize = await (await post('/api/normalize', { text: 'a\n| b | c |\n| --- | --- |' })).json()
    assert.equal(normalize.changed, true)

    const lines = await (await fetch(`${base}/api/activity-lines`)).json()
    assert.ok(lines.groups.length >= 10)

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)

    const missing = await fetch(`${base}/nope.js`)
    assert.equal(missing.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
