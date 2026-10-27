/**
 * Scenario runner for the local DingTalk playground.
 *
 * It drives the REAL compiled renderer (`lib/renderer.js`) with a fake AI Card,
 * a fake reply sink and a fake emotion channel, then records every frame the
 * renderer would have pushed to DingTalk. The browser replays that recording in
 * a DingTalk-shaped chat window, so the markdown/activity/rollover/失败态 you
 * inspect is byte-for-byte what a real conversation receives.
 *
 * Nothing here touches the network: `createCard` is injected by the runner, so
 * `AICard` never constructs an HTTP request.
 */
import { Renderer } from '../lib/renderer.js'
import { cardFrameContent, normalizeCardContent } from '../lib/aicard.js'
import {
  describeToolCall,
  renderActivityLine,
  renderProcessLine,
  renderProcessSettled,
  renderTodoLine,
  todoSnapshot,
} from '../lib/activity.js'
import { ACTIVITY_GALLERY } from './activity-gallery.mjs'
import { scenarios } from './scenarios.mjs'

const REPLY_MODES = ['aicard', 'markdown', 'text']
const LIFECYCLES = ['stream', 'finalize']
const CONVERSATION_TYPES = ['direct', 'group']

/** Defaults mirror `src/config.ts` so the recording matches a stock install. */
export const DEFAULT_OPTIONS = {
  replyMode: 'aicard',
  lifecycle: 'finalize',
  throttleMs: 500,
  maxCardChars: 15_000,
  conversationType: 'direct',
  pace: 1,
}

/** Bad `scenarioId` / option value; the HTTP layer maps it to 400/404. */
export class PlaygroundInputError extends Error {
  constructor(code, field, message) {
    super(message ?? code)
    this.name = 'PlaygroundInputError'
    this.code = code
    this.field = field
    this.status = code === 'unknown_scenario' ? 404 : 400
  }
}

/** Metadata only: the browser needs this before it can run anything. */
export function listScenarios() {
  return scenarios.map((scenario) => {
    // A scenario may be built around a smaller card limit or a non-card carrier;
    // the UI seeds its settings from this so selecting a scenario shows it as
    // intended instead of silently overriding the defaults it was designed for.
    const defaults = { ...DEFAULT_OPTIONS, ...scenario.defaults }
    return {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      tags: scenario.tags ?? [],
      mode: defaults.replyMode,
      conversationType: defaults.conversationType,
      conversationTitle: scenario.conversationTitle,
      defaults: {
        replyMode: defaults.replyMode,
        lifecycle: defaults.lifecycle,
        throttleMs: defaults.throttleMs,
        maxCardChars: defaults.maxCardChars,
        conversationType: defaults.conversationType,
      },
    }
  })
}

/** Resolve scenario defaults + explicit options, rejecting invalid enum values. */
export function resolveOptions(scenario, raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_OPTIONS, ...scenario.defaults, ...input }

  for (const [field, allowed] of [
    ['replyMode', REPLY_MODES],
    ['lifecycle', LIFECYCLES],
    ['conversationType', CONVERSATION_TYPES],
  ]) {
    if (!allowed.includes(merged[field])) {
      throw new PlaygroundInputError('invalid_option', field, `invalid ${field}: ${String(merged[field])}`)
    }
  }
  for (const field of ['throttleMs', 'maxCardChars', 'pace']) {
    if (!Number.isFinite(merged[field]) || merged[field] <= 0) {
      throw new PlaygroundInputError('invalid_option', field, `invalid ${field}: ${String(merged[field])}`)
    }
  }
  return {
    replyMode: merged.replyMode,
    lifecycle: merged.lifecycle,
    throttleMs: Math.round(merged.throttleMs),
    maxCardChars: Math.round(merged.maxCardChars),
    conversationType: merged.conversationType,
    pace: Math.min(1, Math.max(0.05, merged.pace)),
  }
}

/** Split a string into `size`-codepoint deltas without breaking surrogate pairs. */
function deltaChunks(value, size) {
  const chars = [...value]
  const chunks = []
  for (let index = 0; index < chars.length; index += size) chunks.push(chars.slice(index, index + size).join(''))
  return chunks
}

/** Run one scenario and return its recorded timeline. */
export async function runScenario(scenarioId, rawOptions = {}) {
  const scenario = scenarios.find((item) => item.id === scenarioId)
  if (!scenario) throw new PlaygroundInputError('unknown_scenario', 'scenarioId', `unknown scenario: ${scenarioId}`)
  const options = resolveOptions(scenario, rawOptions)

  const startedAt = performance.now()
  const timeline = []
  const logs = []
  const at = () => Math.round(performance.now() - startedAt)
  const push = (entry) => {
    timeline.push({ t: at(), ...entry })
    return entry
  }

  const pace = options.pace
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(ms * pace))))

  const sessionId = 'playground-session'
  const conversationId = 'playground-conversation'
  const conversationType = options.conversationType
  const conversationTitle = scenario.conversationTitle ?? 'DeepSeek Harness'
  const robotName = scenario.robotName ?? 'DeepSeek Harness'
  const user = { nick: scenario.user?.nick ?? '牧曈', staffId: 'u_demo' }

  const inbound = {
    msgId: 'msg_playground_1',
    conversationId,
    conversationType,
    senderStaffId: user.staffId,
    senderNick: user.nick,
    text: scenario.user?.text ?? '你好',
    createAt: String(Date.now()),
    sessionWebhook: 'https://example.invalid/playground',
  }

  // --- fake carriers -------------------------------------------------------
  let cardCount = 0
  const makeCard = () => {
    const cardId = `card-${++cardCount}`
    push({ type: 'card-create', cardId })
    /**
     * One recorded card write. The payload goes through the SAME builder AICard
     * uses, so the recorded frame is byte-identical to what DingTalk receives
     * (`cardFrameContent` = normalize + trailing-newline trim on live frames).
     */
    const record = (kind, content) => {
      const settled = kind !== 'stream' || options.lifecycle === 'finalize'
      push({
        type: 'card-frame',
        cardId,
        kind,
        flowStatus: kind === 'fail' ? 'failed' : settled ? 'finished' : 'inputing',
        content: cardFrameContent(String(content ?? ''), settled),
      })
    }
    return {
      outTrackId: cardId,
      async stream(content) {
        record('stream', content)
      },
      async finish(content) {
        record('finish', content)
      },
      async fail(content) {
        record('fail', content)
      },
      async updateStatic(content) {
        record('update', content)
      },
    }
  }

  const outbound = {
    async sendText(_msg, text) {
      push({ type: 'text', text: String(text) })
      return true
    },
    async sendMarkdown(_msg, title, text) {
      push({ type: 'markdown', title: String(title), text: String(text) })
      return true
    },
  }

  const emotion = {
    async recall() {
      push({ type: 'reaction', state: 'recall', text: '🤔思考中' })
    },
  }

  const renderer = new Renderer({
    config: {
      replyMode: { direct: options.replyMode, group: options.replyMode },
      streaming: {
        enabled: true,
        lifecycle: options.lifecycle,
        throttleMs: Math.max(1, Math.round(options.throttleMs * pace)),
        maxCardChars: options.maxCardChars,
      },
      asyncMode: false,
      ackText: scenario.ackText ?? '收到，正在处理…',
      markdownTitle: scenario.markdownTitle ?? 'DeepSeek Harness',
      emotionFirstResponse: true,
    },
    outbound,
    emotion,
    createCard: async () => makeCard(),
    log: (line) => logs.push({ t: at(), line: String(line) }),
  })

  const send = (event) => renderer.onSessionEvent({ id: sessionId }, event)

  // --- scenario context ----------------------------------------------------
  let callSeq = 0
  const ctx = {
    options,
    conversationId,
    wait,
    /** The user message lands: bubble + 🤔思考中 reaction, then the turn starts. */
    async inbound(text = inbound.text) {
      inbound.text = text
      push({ type: 'inbound', text, msgId: inbound.msgId })
      push({ type: 'reaction', state: 'add', text: '🤔思考中' })
      return renderer.onInbound(sessionId, inbound)
    },
    /** Stream one assistant text block as deltas, then commit it as a message. */
    async text(value, { chunk = 4, delay = 26, commit = true } = {}) {
      for (const piece of deltaChunks(String(value), chunk)) {
        send({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: piece } } })
        await wait(delay)
      }
      if (commit)
        send({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: String(value) }] } } })
    },
    /** Durable todo snapshot; the card keeps only the item in flight. */
    async todos(items) {
      send({ type: 'todo/write', data: { todos: items } })
      await wait(140)
    },
    /** Reasoning deltas only drive the transient 思考中 line. */
    async reasoning(value, { delay = 70 } = {}) {
      send({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: String(value) } } })
      await wait(delay)
    },
    /** One tool call plus its result event. */
    async tool(name, args = {}, { runMs = 340, isError = false, error, commit = true } = {}) {
      const callId = `call_${++callSeq}`
      send({ type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } })
      await wait(runMs)
      if (commit) {
        const block = {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: isError ? 'error' : 'ok' }],
          ...(isError ? { isError: true } : {}),
        }
        send({
          type: 'tool/result',
          data: {
            message: { content: [block], source: { kind: 'tool', callId } },
            ...(error !== undefined ? { error } : {}),
          },
        })
        await wait(40)
      }
      return callId
    },
    /** Another bubble appears in the conversation below the live card. */
    async interleave(entry = { type: 'text', text: '（另一个机器人/用户插话）' }) {
      push(entry)
      renderer.notifyInterleaved(conversationId)
      await wait(120)
    },
    async end(reason = { kind: 'completed' }) {
      send({ type: 'turn/end', data: { reason } })
      return reason
    },
    async error(message, code) {
      return this.end({ kind: 'error', failure: { message, ...(code ? { code } : {}) } })
    },
    async abort() {
      return this.end({ kind: 'aborted' })
    },
  }

  // The reaction is added at intake, before queueing, exactly like the plugin.
  push({ type: 'inbound', text: inbound.text, msgId: inbound.msgId })
  push({ type: 'reaction', state: 'add', text: '🤔思考中' })
  const settled = renderer.onInbound(sessionId, inbound)

  try {
    await scenario.script(ctx)
  } catch (error) {
    logs.push({ t: at(), line: `scenario script threw: ${error instanceof Error ? error.message : error}` })
  }
  await settled

  /**
   * `finalize` is fire-and-forget inside the renderer, so wait for a quiet
   * timeline instead of guessing at a timeout.
   */
  for (let stable = 0, previous = -1, guard = 0; stable < 3 && guard < 400; guard++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const length = timeline.length
    stable = length === previous ? stable + 1 : 0
    previous = length
  }

  const frames = timeline.filter((entry) => entry.type === 'card-frame')
  const cards = timeline.filter((entry) => entry.type === 'card-create')
  const lastFrame = frames[frames.length - 1]

  return {
    scenario: {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      tags: scenario.tags ?? [],
      mode: options.replyMode,
      conversationType: options.conversationType,
    },
    options,
    conversation: { type: conversationType, title: conversationTitle, robotName, user },
    durationMs: at(),
    timeline,
    logs,
    stats: {
      entries: timeline.length,
      frames: frames.length,
      cards: cards.length,
      finalChars: lastFrame ? lastFrame.content.length : 0,
    },
  }
}

/** `/api/normalize` payload: what `AICard` does to a raw markdown frame, and why. */
export function normalizeMarkdown(input, { normalize = true } = {}) {
  const text = String(input ?? '')
  if (!normalize) return { input: text, output: text, changed: false, notes: [] }
  const output = normalizeCardContent(text)
  const notes = []
  const addedBlankLines = output.split('\n').length - text.split('\n').length
  if (addedBlankLines > 0) notes.push(`表格前补了 ${addedBlankLines} 个空行（钉钉不渲染紧贴段落的表格）`)
  const crlf = /\r\n/.test(text)
  if (crlf) notes.push('CRLF 已归一为 LF')
  return { input: text, output, changed: output !== text, notes }
}

/**
 * `/api/activity-lines` payload: rendered through the real activity module.
 * `process` shows the 简洁-mode line in both shapes — the breadcrumb while the
 * turn runs and the folded header the card settles with. Both are single plain
 * paragraphs: the card must not spend a block (and a paragraph gap) per step.
 */
export function activityLines() {
  const step = (name, args, state) => ({ ...describeToolCall(name, args, `gallery-${name}`), state })
  const steps = [
    step('read', { file_path: 'src/renderer.ts' }, 'done'),
    step('grep', { query: 'carryOffset' }, 'done'),
    step('bash', { command: 'pnpm run ci', description: '运行完整门禁' }, 'running'),
  ]
  const settledSteps = steps.map((item) => ({ ...item, state: 'done' }))
  return {
    thinking: renderActivityLine({ kind: 'thinking' }),
    process: {
      todo: renderTodoLine(
        todoSnapshot([
          { content: '把过程线压成一行', status: 'completed' },
          { content: '给任务清单留一行', status: 'in_progress' },
          { content: '补真机回归', status: 'pending' },
        ]),
      ),
      line: renderProcessLine({ steps, thinkingMs: 12_000, thinking: false, elapsedMs: 42_000 }),
      thinking: renderProcessLine({ steps: [], thinkingMs: 0, thinking: true, elapsedMs: 3_000 }),
      settled: renderProcessSettled(
        { steps: settledSteps, thinkingMs: 0, thinking: false, elapsedMs: 42_000 },
        'completed',
      ),
      failed: renderProcessSettled(
        { steps: settledSteps.slice(0, 2), thinkingMs: 0, thinking: false, elapsedMs: 18_000 },
        'failed',
      ),
    },
    groups: ACTIVITY_GALLERY.map((group) => {
      const make = (state) => renderActivityLine({ ...describeToolCall(group.name, group.args), state })
      return {
        variant: group.variant,
        name: group.name,
        sample: group.sample,
        lines: { running: make('running'), done: make('done'), error: make('error'), stopped: make('stopped') },
      }
    }),
  }
}
