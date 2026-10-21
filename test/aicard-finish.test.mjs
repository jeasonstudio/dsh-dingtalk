import assert from 'node:assert/strict'
import test from 'node:test'

import { AICard } from '../lib/aicard.js'

function headers(init) {
  return init?.headers ?? {}
}

async function withFetch(handler, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), method: init?.method, body, headers: headers(init) })
    return handler(String(url), init, calls)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

async function createCard(logs = []) {
  return AICard.create({
    token: async () => 'token',
    robotCode: 'robot',
    target: { type: 'user', userId: 'u1' },
    log: (line) => logs.push(line),
  })
}

test('最终流式帧失败时仍写入 FINISHED，避免卡片停在输入中', async () => {
  await withFetch(
    async (url) => {
      if (url.includes('/v1.0/card/streaming')) return new Response('boom', { status: 500 })
      return new Response('{}', { status: 200 })
    },
    async (calls) => {
      const logs = []
      const card = await createCard(logs)
      assert.ok(card)

      await card.finish('最终答案')

      assert.ok(logs.some((line) => line.includes('forcing FINISHED')))
      const terminal = calls.filter((call) => call.method === 'PUT' && call.url.includes('/v1.0/card/instances')).at(-1)
      assert.equal(terminal?.body?.cardData?.cardParamMap?.flowStatus, '3')
      assert.equal(terminal?.body?.cardData?.cardParamMap?.msgContent, '最终答案')
    },
  )
})

test('FINISHED 写入遇到瞬时失败时重试一次', async () => {
  let failedOnce = false
  await withFetch(
    async (url, init) => {
      if (init?.method === 'PUT' && url.includes('/v1.0/card/instances')) {
        const flowStatus = JSON.parse(init.body).cardData.cardParamMap.flowStatus
        if (flowStatus === '3' && !failedOnce) {
          failedOnce = true
          return new Response('flaky', { status: 500 })
        }
      }
      return new Response('{}', { status: 200 })
    },
    async (calls) => {
      const card = await createCard()
      assert.ok(card)

      await card.finish('最终答案')

      const finished = calls.filter(
        (call) => call.method === 'PUT' && call.body?.cardData?.cardParamMap?.flowStatus === '3',
      )
      assert.equal(finished.length, 2)
      assert.equal(finished[1].method, 'PUT')
    },
  )
})
