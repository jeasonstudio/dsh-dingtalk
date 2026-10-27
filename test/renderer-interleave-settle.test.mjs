/**
 * A bubble can land below the live card right before the turn ends, so the
 * "roll over" decision may only ever be made at finalize time. These cases pin
 * that the settled cards never repeat text and never lie about output that
 * does not exist.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Renderer } from '../lib/renderer.js'

function createHarness(options = {}) {
  const frames = []
  const finished = []
  let cards = 0
  const card = {
    async stream(content) {
      frames.push(content)
    },
    async finish(content) {
      finished.push(content)
    },
    async fail(content) {
      finished.push(`failed:${content}`)
    },
  }
  const renderer = new Renderer({
    config: {
      replyMode: { direct: 'aicard', group: 'aicard' },
      streaming: { enabled: options.streaming !== false, throttleMs: 1, maxCardChars: 20_000 },
      asyncMode: false,
      ackText: 'ack',
      markdownTitle: 'DSH',
      emotionFirstResponse: false,
    },
    outbound: { async sendMarkdown() {}, async sendText() {} },
    emotion: { async recall() {} },
    async createCard() {
      cards += 1
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
  const send = (event) => renderer.onSessionEvent({ id: 's1' }, event)
  return {
    renderer,
    msg,
    frames,
    finished,
    cardCount: () => cards,
    tick,
    send,
    text(value) {
      send({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: value } } })
    },
    message(value) {
      send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: value }] } } })
    },
    end(kind = 'completed') {
      send({ type: 'turn/end', data: { reason: { kind } } })
    },
    interleave() {
      renderer.notifyInterleaved('c1')
    },
  }
}

test('插话后立刻收尾：旧卡只留已流出文本，新卡只承接剩余', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.message('第一段')
  await harness.tick()
  assert.deepEqual(harness.frames, ['第一段'])

  // A newer bubble lands below the card, then the last text arrives, then the
  // turn ends before the throttle fires again.
  harness.interleave()
  harness.text('第二段')
  harness.message('第二段')
  harness.end()
  await settled
  await harness.tick(40)

  assert.equal(harness.cardCount(), 2)
  assert.equal(harness.finished[0], '第一段\n\n> ⤵️ 输出继续，见下方新卡片')
  assert.equal(harness.finished[1], '第二段')
  // The answer must exist exactly once across the two settled cards.
  assert.equal(harness.finished.join('').split('第一段').length - 1, 1)
})

test('已全部流出后插话：就地定稿，不换卡也不重复', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.message('第一段')
  await harness.tick()

  harness.interleave()
  harness.end()
  await settled
  await harness.tick(40)

  assert.equal(harness.cardCount(), 1)
  assert.deepEqual(harness.finished, ['第一段'])
  assert.doesNotMatch(harness.finished[0], /输出继续/)
})

test('插话后报错同样不重复已流出的正文', async () => {
  const harness = createHarness()
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.message('第一段')
  await harness.tick()

  harness.interleave()
  harness.send({ type: 'turn/end', data: { reason: { kind: 'error', failure: { message: '429 Too Many Requests' } } } })
  await settled
  await harness.tick(40)

  assert.equal(harness.cardCount(), 1)
  assert.equal(harness.finished.length, 1)
  assert.match(harness.finished[0], /^failed:/)
  assert.match(harness.finished[0], /模型限流/)
  assert.equal(harness.finished[0].split('第一段').length - 1, 1)
})

test('关闭流式时插话不会把同一段正文写成两张卡', async () => {
  const harness = createHarness({ streaming: false })
  const settled = harness.renderer.onInbound('s1', harness.msg)

  harness.text('第一段')
  harness.message('第一段')
  harness.interleave()
  harness.end()
  await settled
  await harness.tick(40)

  assert.equal(harness.cardCount(), 1)
  assert.deepEqual(harness.finished, ['第一段'])
})
