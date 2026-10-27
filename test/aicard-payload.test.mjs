/**
 * The playground shows the bytes DingTalk receives. That promise is only worth
 * something if the page and the network layer share ONE payload builder, so
 * these tests pin the wire payloads to `cardFrameContent` / `normalizeCardContent`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AICard, cardFrameContent, normalizeCardContent } from '../lib/aicard.js'

async function withFetch(handler, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined })
    return handler(String(url), init)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const ok = async () => new Response('{}', { status: 200 })

async function createCard(lifecycle) {
  return AICard.create({
    token: async () => 'token',
    robotCode: 'robot',
    target: { type: 'user', userId: 'u1' },
    log: () => {},
    lifecycle,
  })
}

const streamingFrames = (calls) => calls.filter((call) => call.url.includes('/v1.0/card/streaming'))

// Table glued to a paragraph (DingTalk drops it) + trailing newlines: both are
// rewritten by the payload builder, so the difference is visible in the bytes.
const RAW = '结论如下：\n| 项 | 值 |\n| --- | --- |\n| 帧 | 定稿 |\n\n'

test('流式帧的 msgContent 就是 cardFrameContent 的输出', async () => {
  await withFetch(ok, async (calls) => {
    const card = await createCard('stream')
    await card.stream(RAW, false)
    const frame = streamingFrames(calls).at(-1)
    assert.equal(frame?.body?.content, cardFrameContent(RAW, false))
    // Live frames drop the trailing blank lines and get the table blank line.
    assert.equal(frame?.body?.content.endsWith('\n'), false)
    assert.match(frame?.body?.content, /结论如下：\n\n\| 项 \| 值 \|/)
    assert.equal(frame?.body?.isFinalize, false)
  })
})

test('finalize 生命周期下的帧与实例内容分别等于两个构造器', async () => {
  await withFetch(ok, async (calls) => {
    const card = await createCard('finalize')
    await card.finish(RAW)
    // finalize lifecycle: a settling stream frame, then the FINISHED instance.
    const frame = streamingFrames(calls).at(-1)
    assert.equal(frame?.body?.content, cardFrameContent(RAW, true))
    assert.equal(frame?.body?.isFinalize, true)
    const instance = calls.filter((call) => call.url.includes('/v1.0/card/instances')).at(-1)
    assert.equal(instance?.body?.cardData?.cardParamMap?.flowStatus, '3')
    assert.equal(instance?.body?.cardData?.cardParamMap?.msgContent, normalizeCardContent(RAW))
    // The finished content keeps its trailing newline: it is the final snapshot.
    assert.equal(instance?.body?.cardData?.cardParamMap?.msgContent.endsWith('\n'), true)
  })
})

test('输入中实例的 msgContent 也走同一个规范化', async () => {
  await withFetch(ok, async (calls) => {
    const card = await createCard('stream')
    await card.stream(RAW, false)
    const inputing = calls.find((call) => call.method === 'PUT' && call.url.includes('/v1.0/card/instances'))
    assert.equal(inputing?.body?.cardData?.cardParamMap?.flowStatus, '2')
    assert.equal(inputing?.body?.cardData?.cardParamMap?.msgContent, normalizeCardContent(RAW))
  })
})

test('payload 构造器是幂等的，录制帧重复规范化不会漂移', () => {
  for (const raw of [RAW, '纯文本', '| a | b |\n| --- | --- |\n| 1 | 2 |', '', 'a\n\n\n']) {
    for (const finished of [true, false]) {
      const once = cardFrameContent(raw, finished)
      assert.equal(cardFrameContent(once, finished), once, JSON.stringify({ raw, finished }))
    }
  }
})
