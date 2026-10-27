/**
 * Playground player.
 *
 * Fetches a recorded timeline from the local playground server (or the bundled
 * fixture) and replays it into a DingTalk chat mockup, one entry at a time.
 *
 * Every visual state is derived from the timeline alone: seeking always rebuilds
 * the transcript from entry 0, so a scrubbed player cannot show a half-applied
 * card or a reaction attached to the wrong bubble. The frame inspector, markdown
 * lab and activity gallery are read-only debug views over the same data.
 */

import { renderMarkdown } from './markdown.js'

const FIXTURE_URL = './fixtures/demo-run.json'
const PREFS_KEY = 'dsh-dingtalk-playground:prefs'
/** 09:41 is a synthetic chat clock; separators stay relative to the run, never a real date. */
const CLOCK_BASE_MINUTES = 9 * 60 + 41
const REACTION_TEXT = '🤔思考中'
const LAB_DEBOUNCE_MS = 120

/** Matches `playground/runner.mjs` DEFAULT_OPTIONS, i.e. a stock plugin install. */
const DEFAULT_SETTINGS = {
  replyMode: 'aicard',
  lifecycle: 'finalize',
  throttleMs: 500,
  maxCardChars: 15000,
  conversationType: 'direct',
}

const REPLY_MODES = ['aicard', 'markdown', 'text']
const LIFECYCLES = ['stream', 'finalize']
const CONVERSATION_TYPES = ['direct', 'group']

const LAB_SAMPLE = [
  '## 结论',
  '',
  '先把 **流式帧** 和 **定稿帧** 分开处理：卡片只保留一条实时活动行。',
  '',
  '> ✅ 已执行命令 · pnpm run ci',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| 帧数 | 42 |',
  '| 字符 | 1,204 |',
  '',
  '```ts',
  "const frames = timeline.filter((entry) => entry.type === 'card-frame')",
  '```',
].join('\n')

/**
 * Last-resort transcript: double-clicking index.html without a server AND
 * without the fixture must still paint a chat instead of a blank page.
 */
const BUILTIN_RUN = {
  scenario: {
    id: 'offline-demo',
    title: '离线示例回合',
    description: '内置兜底 timeline：没有服务端也能看到基本观感',
    tags: ['兜底'],
    mode: 'aicard',
    conversationType: 'direct',
  },
  options: { ...DEFAULT_SETTINGS, pace: 1 },
  conversation: {
    type: 'direct',
    title: 'DSH 助手',
    robotName: 'DeepSeek Harness',
    user: { nick: '牧曈', staffId: 'u_demo' },
  },
  durationMs: 3600,
  timeline: [
    { t: 0, type: 'inbound', text: '帮我看看 playground 的进度，顺便跑一下测试', msgId: 'msg_demo_1' },
    { t: 0, type: 'reaction', state: 'add', text: REACTION_TEXT },
    { t: 120, type: 'card-create', cardId: 'card-1' },
    {
      t: 600,
      type: 'card-frame',
      cardId: 'card-1',
      kind: 'stream',
      flowStatus: 'inputing',
      content: '> 💭 正在思考…',
    },
    {
      t: 1400,
      type: 'card-frame',
      cardId: 'card-1',
      kind: 'stream',
      flowStatus: 'inputing',
      content: '> ⚙️ 正在执行命令 · pnpm exec prettier --check playground/public',
    },
    {
      t: 2400,
      type: 'card-frame',
      cardId: 'card-1',
      kind: 'finish',
      flowStatus: 'finished',
      content: [
        '## 进度',
        '',
        '> ✅ 已执行命令 · pnpm exec prettier --check playground/public',
        '',
        '| 项 | 状态 |',
        '| --- | --- |',
        '| 页面 | 完成 |',
        '| 测试 | 通过 |',
      ].join('\n'),
    },
    { t: 3000, type: 'reaction', state: 'recall', text: REACTION_TEXT },
    { t: 3400, type: 'turn-end', reason: { kind: 'completed' } },
  ],
  logs: [],
  stats: { entries: 8, frames: 3, cards: 1, finalChars: 120 },
}

/* ------------------------------------------------------------------------ */
/* small helpers                                                            */
/* ------------------------------------------------------------------------ */

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)

const asCount = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback)

const codePointLength = (value) => (typeof value === 'string' ? [...value].length : 0)

function el(tag, className, textContent) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (textContent !== undefined) node.textContent = textContent
  return node
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(value).replace(/[&<>"']/g, (char) => map[char])
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** `fetch` with a timeout: a dead server must not leave the UI spinning forever. */
async function apiFetch(path, init, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(path, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function httpErrorText(response) {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body)
    if (isObject(parsed) && parsed.error) {
      return `HTTP ${response.status} · ${parsed.error}${parsed.field ? ` (${parsed.field})` : ''}`
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 160)
  // A stray static server answers /api/* with an HTML error page; quoting that
  // markup at the author is noise, the status code says everything.
  const readable = detail.startsWith('<') ? '' : detail
  return `HTTP ${response.status}${readable ? ` · ${readable}` : ''}`
}

/* ------------------------------------------------------------------------ */
/* DOM refs + state                                                         */
/* ------------------------------------------------------------------------ */

const byId = (id) => document.getElementById(id)

const dom = {
  scenarioSelect: byId('scenarioSelect'),
  runBtn: byId('runBtn'),
  resetBtn: byId('resetBtn'),
  playBtn: byId('playBtn'),
  stepBtn: byId('stepBtn'),
  speedGroup: byId('speedGroup'),
  progress: byId('progress'),
  progressLabel: byId('progressLabel'),
  shellToggle: byId('shellToggle'),
  shellLegend: byId('shellLegend'),
  dirtyHint: byId('dirtyHint'),
  settingsPopover: byId('settingsPopover'),
  setReplyMode: byId('setReplyMode'),
  setLifecycle: byId('setLifecycle'),
  setThrottleMs: byId('setThrottleMs'),
  setMaxCardChars: byId('setMaxCardChars'),
  setConversationType: byId('setConversationType'),
  themeGroup: byId('themeGroup'),
  deviceGroup: byId('deviceGroup'),
  settingBadges: {
    replyMode: byId('badgeReplyMode'),
    lifecycle: byId('badgeLifecycle'),
    throttleMs: byId('badgeThrottleMs'),
    maxCardChars: byId('badgeMaxCardChars'),
    conversationType: byId('badgeConversationType'),
  },
  statusBar: byId('statusBar'),
  statusText: byId('statusText'),
  statusClose: byId('statusClose'),
  scenarioList: byId('scenarioList'),
  scenarioCount: byId('scenarioCount'),
  labPanel: byId('labPanel'),
  normalizeToggle: byId('normalizeToggle'),
  labInput: byId('labInput'),
  labCount: byId('labCount'),
  labNotes: byId('labNotes'),
  labPreview: byId('labPreview'),
  galleryPanel: byId('galleryPanel'),
  galleryBody: byId('galleryBody'),
  deviceFrame: byId('deviceFrame'),
  deviceHint: byId('deviceHint'),
  chatBody: byId('chatBody'),
  chatTitle: byId('chatTitle'),
  messageList: byId('messageList'),
  frameStats: byId('frameStats'),
  frameList: byId('frameList'),
  frameDetailTitle: byId('frameDetailTitle'),
  frameContent: byId('frameContent'),
  jumpBtn: byId('jumpBtn'),
  copyFrameBtn: byId('copyFrameBtn'),
  loadLabBtn: byId('loadLabBtn'),
}

const settingInputs = {
  replyMode: dom.setReplyMode,
  lifecycle: dom.setLifecycle,
  throttleMs: dom.setThrottleMs,
  maxCardChars: dom.setMaxCardChars,
  conversationType: dom.setConversationType,
}

const state = {
  scenarios: [],
  result: null,
  index: 0,
  playing: false,
  speed: 1,
  theme: 'light',
  device: 'mobile',
  /** Outline the client-rendered chrome so screenshots are not misread as payload. */
  shell: false,
  /** Global preferences only; scenario-scoped values live in scenarioDefaults. */
  settings: { lifecycle: DEFAULT_SETTINGS.lifecycle },
  scenarioDefaults: { ...DEFAULT_SETTINGS },
  /** Fields the author changed by hand; only these travel in POST /api/run. */
  overrides: {},
  currentScenarioId: null,
  appliedSettings: { ...DEFAULT_SETTINGS },
  offline: false,
  running: false,
  selectedFrame: null,
  galleryLoaded: false,
}

/** Playback timer; one at a time, always cleared before rescheduling. */
let playTimer = null
/** Previous row's sender; a change means DingTalk's wider 24px gap. */
let lastSender = null
/** The inbound bubble a `reaction` entry attaches to. */
let lastInbound = null
const cardEls = new Map()
const flashTimers = new WeakMap()
let statusTimer = null
let labTimer = null
let labRequestId = 0

/* ------------------------------------------------------------------------ */
/* markdown                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * `renderMarkdown` escapes all text per contract; the fallback here only keeps a
 * frame readable if the renderer ever throws, and it escapes too.
 */
function markdownHtml(source) {
  const value = typeof source === 'string' ? source : String(source ?? '')
  try {
    const html = renderMarkdown(value, { lineBreakAsBr: true })
    if (typeof html === 'string') return html
  } catch (error) {
    console.warn('[playground] renderMarkdown failed', error)
  }
  return `<p>${escapeHtml(value)}</p>`
}

/** Render markdown into a container, wrapping tables so they scroll on their own. */
function mdInto(container, source) {
  container.innerHTML = markdownHtml(source)
  for (const table of container.querySelectorAll('table')) {
    const wrap = el('div', 'md-table')
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

/* ------------------------------------------------------------------------ */
/* timeline access                                                          */
/* ------------------------------------------------------------------------ */

const entries = () => (state.result && Array.isArray(state.result.timeline) ? state.result.timeline : [])

function normalizeResult(raw) {
  const source = isObject(raw) ? raw : {}
  const scenario = isObject(source.scenario) ? source.scenario : {}
  const conversation = isObject(source.conversation) ? source.conversation : {}
  const user = isObject(conversation.user) ? conversation.user : {}
  const stats = isObject(source.stats) ? source.stats : {}
  const timeline = Array.isArray(source.timeline) ? source.timeline.filter(isObject) : []
  const frames = timeline.filter((entry) => entry.type === 'card-frame')
  const cards = timeline.filter((entry) => entry.type === 'card-create')
  const lastFrame = frames[frames.length - 1]

  return {
    scenario: {
      id: asText(scenario.id, 'unknown'),
      title: asText(scenario.title, '未命名剧本'),
      description: asText(scenario.description, ''),
      tags: Array.isArray(scenario.tags) ? scenario.tags.filter((tag) => typeof tag === 'string') : [],
      mode: asText(scenario.mode, DEFAULT_SETTINGS.replyMode),
      conversationType: conversation.type === 'group' ? 'group' : 'direct',
    },
    options: isObject(source.options) ? source.options : {},
    conversation: {
      type: conversation.type === 'group' ? 'group' : 'direct',
      title: asText(conversation.title, 'DeepSeek Harness'),
      robotName: asText(conversation.robotName, 'DeepSeek Harness'),
      user: { nick: asText(user.nick, '牧曈') },
    },
    durationMs: asCount(source.durationMs, 0),
    timeline,
    stats: {
      entries: asCount(stats.entries, timeline.length),
      frames: asCount(stats.frames, frames.length),
      cards: asCount(stats.cards, cards.length),
      finalChars: asCount(stats.finalChars, lastFrame ? codePointLength(lastFrame.content) : 0),
    },
  }
}

function normalizeScenario(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    id: asText(source.id, ''),
    title: asText(source.title, asText(source.id, '未命名剧本')),
    description: asText(source.description, ''),
    tags: Array.isArray(source.tags) ? source.tags.filter((tag) => typeof tag === 'string') : [],
    mode: asText(source.mode, DEFAULT_SETTINGS.replyMode),
    conversationType: source.conversationType === 'group' ? 'group' : 'direct',
    defaults: isObject(source.defaults) ? source.defaults : null,
  }
}

/* ------------------------------------------------------------------------ */
/* chat transcript                                                          */
/* ------------------------------------------------------------------------ */

function userInitial() {
  const nick = state.result?.conversation?.user?.nick ?? '牧曈'
  return [...nick][0] ?? '我'
}

function resetTranscript() {
  dom.messageList.replaceChildren()
  cardEls.clear()
  lastInbound = null
  lastSender = null
}

/**
 * Append one chat row (avatar + bubble). Rows from different senders get extra
 * spacing, matching DingTalk's turn grouping.
 */
function appendRow(kind, bubble, rowKind = 'msg-row') {
  const row = el('div', `${rowKind} ${kind}`)
  const avatar = el('div', `avatar avatar-${kind}`, kind === 'me' ? userInitial() : '🤖')
  // DingTalk draws the avatar, not the plugin.
  avatar.dataset.emulated = kind === 'me' ? 'avatar-user' : 'avatar-robot'
  if (kind === 'me') avatar.setAttribute('aria-hidden', 'true')
  row.append(avatar, bubble)
  if (lastSender !== null && lastSender !== kind) row.classList.add('gap-lg')
  dom.messageList.append(row)
  lastSender = kind
  return row
}

function appendTimeSeparator(t) {
  const separator = el('div', 'time-sep', formatClock(t))
  separator.dataset.emulated = 'time-separator'
  separator.title = `t = ${t}ms（相对回合开始）`
  dom.messageList.append(separator)
}

/** Synthetic chat clock derived from the entry's relative time. */
function formatClock(t) {
  const ms = Number.isFinite(t) ? Math.max(0, t) : 0
  const totalMinutes = CLOCK_BASE_MINUTES + Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function appendInbound(entry) {
  const text = asText(entry.text, '')
  const bubble = el('div', 'bubble bubble-me', text)
  const row = appendRow('me', bubble)
  lastInbound = { row }
}

/** 150ms fade on recall; the DOM node is detached afterwards. */
function applyReaction(entry) {
  if (!lastInbound) return
  const target = lastInbound.row
  const recalled = entry.state === 'recall'
  const existing = target.querySelector('.reaction-pill')

  if (recalled) {
    if (!existing) return
    existing.classList.add('leaving')
    target.classList.remove('has-reaction')
    setTimeout(() => existing.remove(), 150)
    return
  }

  const label = asText(entry.text, REACTION_TEXT)
  if (existing) {
    existing.textContent = label
    return
  }
  const pill = el('span', 'reaction-pill', label)
  pill.dataset.emulated = 'reaction-pill'
  target.append(pill)
  target.classList.add('has-reaction')
}

function createCardBubble(entry) {
  const cardId = asText(entry.cardId, '')

  const bubble = el('div', 'bubble bubble-robot bubble-card')
  const card = el('div', 'ai-card')

  const head = el('div', 'ai-card-head')
  head.dataset.emulated = 'card-header'
  const label = el('span', 'ai-card-label', state.result?.conversation?.robotName ?? 'DeepSeek Harness')
  const dot = el('span', 'status-dot inputing')
  dot.setAttribute('aria-label', '卡片状态：输入中')
  head.append(label, dot)

  const body = el('div', 'md ai-card-body')

  const typing = el('div', 'typing')
  typing.dataset.emulated = 'typing-indicator'
  const typingLabel = el('span', 'typing-label', '输入中')
  const dots = el('span', 'typing-dots')
  for (let index = 0; index < 3; index += 1) dots.append(el('i'))
  typing.append(typingLabel, dots)

  const error = el('div', 'ai-card-error')
  error.dataset.emulated = 'error-strip'
  error.hidden = true
  error.textContent = '⚠️ AI 卡片处于失败态：钉钉端会显示失败样式，正文可能不可折叠'

  card.append(head, body, typing, error)
  bubble.append(card)
  appendRow('robot', bubble)

  cardEls.set(cardId, { bubble, card, body, dot, typing, error })
}

function updateCardFrame(entry) {
  const view = cardEls.get(asText(entry.cardId, ''))
  if (!view) return

  const content = typeof entry.content === 'string' ? entry.content : ''
  if (content.trim()) mdInto(view.body, content)
  else view.body.replaceChildren(el('p', 'card-placeholder', '（空内容）'))

  // flowStatus is the contract's source of truth; `kind` is only a method name.
  const flowStatus = pick(entry.flowStatus, ['inputing', 'finished', 'failed'], 'finished')
  view.dot.className = `status-dot ${flowStatus}`
  view.dot.setAttribute(
    'aria-label',
    `卡片状态：${flowStatus === 'inputing' ? '输入中' : flowStatus === 'failed' ? '失败' : '已定型'}`,
  )
  view.typing.hidden = flowStatus !== 'inputing'
  view.error.hidden = flowStatus !== 'failed'
  view.card.classList.toggle('is-failed', flowStatus === 'failed')
}

function appendMarkdownBubble(entry) {
  const bubble = el('div', 'bubble bubble-robot md-bubble')
  const title = asText(entry.title, '')
  if (title) {
    const titleRow = el('div', 'md-title', title)
    // The fallback bubble's name row is chrome; its markdown body is payload.
    titleRow.dataset.emulated = 'markdown-title'
    bubble.append(titleRow)
  }
  const body = el('div', 'md')
  mdInto(body, asText(entry.text, ''))
  bubble.append(body)
  appendRow('robot', bubble)
}

function appendTextBubble(entry) {
  const bubble = el('div', 'bubble bubble-robot text-bubble', asText(entry.text, ''))
  appendRow('robot', bubble)
}

/** Apply one timeline entry to the chat. Unknown types are debug-only noise. */
function applyEntry(entry) {
  if (!isObject(entry)) return
  switch (entry.type) {
    case 'inbound':
      appendTimeSeparator(asCount(entry.t, 0))
      appendInbound(entry)
      break
    case 'reaction':
      applyReaction(entry)
      break
    case 'card-create':
      createCardBubble(entry)
      break
    case 'card-frame':
      updateCardFrame(entry)
      break
    case 'markdown':
      appendMarkdownBubble(entry)
      break
    case 'text':
      appendTextBubble(entry)
      break
    default:
      // `turn-end` (and anything newer) only matters to the inspector.
      break
  }
}

/** Rewind/seek = replay the first `index` entries from a clean transcript. */
function rebuild(index) {
  const total = entries().length
  const target = Math.min(Math.max(0, Number.isFinite(index) ? Math.round(index) : 0), total)
  resetTranscript()
  const list = entries()
  for (let i = 0; i < target; i += 1) applyEntry(list[i])
  state.index = target
  syncPlayback()
  renderFrameHighlight()
  scrollChatToBottom(true)
}

/* ------------------------------------------------------------------------ */
/* playback                                                                 */
/* ------------------------------------------------------------------------ */

function scheduleNext() {
  if (playTimer) {
    clearTimeout(playTimer)
    playTimer = null
  }
  if (!state.playing) return

  const list = entries()
  if (state.index >= list.length) {
    state.playing = false
    syncPlayback()
    return
  }

  // Timing comes from the recorded gaps, so 2× really means "twice as fast as
  // the real turn", including the long tool stalls.
  const current = list[state.index]
  const previous = state.index > 0 ? list[state.index - 1] : current
  const gap = Math.max(0, (current.t ?? 0) - (previous.t ?? 0)) / state.speed
  playTimer = setTimeout(() => stepForward(), Math.max(16, gap))
}

function stepForward() {
  playTimer = null
  const list = entries()
  if (state.index >= list.length) {
    state.playing = false
    syncPlayback()
    return
  }
  applyEntry(list[state.index])
  state.index += 1
  syncPlayback()
  renderFrameHighlight()
  scrollChatToBottom()
  if (state.playing) scheduleNext()
}

function pausePlayback() {
  state.playing = false
  if (playTimer) {
    clearTimeout(playTimer)
    playTimer = null
  }
  syncPlayback()
}

function togglePlayback() {
  if (!entries().length) return
  if (state.playing) {
    pausePlayback()
    return
  }
  if (state.index >= entries().length) rebuild(0)
  state.playing = true
  syncPlayback()
  scheduleNext()
}

function singleStep() {
  if (!entries().length) return
  if (state.playing) pausePlayback()
  stepForward()
}

function stepBack() {
  if (!entries().length) return
  pausePlayback()
  rebuild(state.index - 1)
}

function resetPlayback() {
  pausePlayback()
  rebuild(0)
}

function setSpeed(value) {
  if (!Number.isFinite(value) || value <= 0) return
  state.speed = value
  savePrefs()
  syncPlayback()
  if (state.playing) scheduleNext()
}

function syncPlayback() {
  const total = entries().length
  const index = Math.min(state.index, total)

  if (dom.progress.max !== String(total)) dom.progress.max = String(total)
  dom.progress.value = String(index)
  dom.progress.disabled = total === 0
  dom.progressLabel.textContent = `${index} / ${total}`
  dom.playBtn.textContent = state.playing ? '⏸' : '▶'
  dom.playBtn.setAttribute('aria-pressed', String(state.playing))
  dom.playBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放')
  dom.playBtn.disabled = total === 0
  dom.stepBtn.disabled = total === 0
  dom.resetBtn.disabled = total === 0
  for (const button of dom.speedGroup.querySelectorAll('[data-speed]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === state.speed))
  }
  updateDeviceHint()
}

function updateDeviceHint() {
  const total = entries().length
  const size = state.device === 'desktop' ? '桌面 560×720' : '手机 390×720'
  const phase = total === 0 ? '等待剧本' : state.playing ? '播放中' : state.index >= total ? '已到末帧' : '已暂停'
  dom.deviceHint.textContent = `${size} · 第 ${state.index} / ${total} 帧 · ${state.speed}× · ${phase}`
}

function scrollChatToBottom(force = false) {
  const body = dom.chatBody
  // Only follow the tail when the reader is already there; scrubbing back should
  // not yank the viewport away from the frame being inspected.
  const distance = body.scrollHeight - body.scrollTop - body.clientHeight
  if (force || distance < 120) body.scrollTop = body.scrollHeight
}

/* ------------------------------------------------------------------------ */
/* frame inspector                                                          */
/* ------------------------------------------------------------------------ */

function frameDetail(entry) {
  const type = String(entry.type ?? '')
  switch (type) {
    case 'inbound':
      return { chars: codePointLength(entry.text), raw: String(entry.text ?? '') }
    case 'card-frame':
      return { chars: codePointLength(entry.content), raw: String(entry.content ?? '') }
    case 'markdown':
    case 'text':
      return { chars: codePointLength(entry.text), raw: String(entry.text ?? '') }
    case 'reaction':
      return {
        chars: codePointLength(entry.text),
        raw: `state: ${String(entry.state ?? '')}\ntext: ${String(entry.text ?? '')}`,
      }
    case 'card-create':
      return { chars: null, raw: `cardId: ${String(entry.cardId ?? '')}` }
    default:
      return { chars: null, raw: safeJson(entry) }
  }
}

function renderFrames() {
  const list = entries()
  dom.frameList.replaceChildren()

  if (!list.length) {
    dom.frameList.append(el('p', 'empty', '还没有 timeline：选一个剧本，点「运行」。'))
    return
  }

  list.forEach((entry, index) => {
    const detail = frameDetail(entry)
    const row = el('button', 'frame-row')
    row.type = 'button'
    row.dataset.index = String(index)
    row.title = `${String(entry.type ?? '')} · t=${String(entry.t ?? 0)}ms`
    row.append(
      el('span', 'frame-t', `${String(entry.t ?? 0)}ms`),
      el('span', 'frame-type', String(entry.type ?? '?')),
      el('span', 'frame-card', String(entry.cardId ?? '')),
      el('span', 'frame-chars', detail.chars === null ? '' : String(detail.chars)),
    )
    row.addEventListener('click', () => selectFrame(index))
    dom.frameList.append(row)
  })

  renderFrameHighlight()
}

function selectFrame(index) {
  const entry = entries()[index]
  if (!entry) return
  state.selectedFrame = index
  const detail = frameDetail(entry)
  dom.frameDetailTitle.textContent = `#${index + 1} · ${String(entry.type ?? '?')} · t=${String(entry.t ?? 0)}ms`
  dom.frameContent.textContent = detail.raw.trim() ? detail.raw : '（该帧没有正文）'
  setFrameActionsEnabled(true)
  renderFrameHighlight()
}

function setFrameActionsEnabled(enabled) {
  dom.jumpBtn.disabled = !enabled
  dom.copyFrameBtn.disabled = !enabled
  dom.loadLabBtn.disabled = !enabled
}

function clearFrameDetail() {
  state.selectedFrame = null
  dom.frameDetailTitle.textContent = '选择一帧查看原始 content'
  dom.frameContent.textContent = '没有选中帧。'
  setFrameActionsEnabled(false)
}

function renderFrameHighlight() {
  const current = state.index - 1
  for (const row of dom.frameList.querySelectorAll('.frame-row')) {
    const index = Number(row.dataset.index)
    row.classList.toggle('is-current', index === current)
    row.classList.toggle('is-selected', index === state.selectedFrame)
  }
  const active = dom.frameList.querySelector('.frame-row.is-current')
  if (active) revealRow(dom.frameList, active)
}

/** Scroll only the inspector list, never the page (autoplay would jitter). */
function revealRow(list, row) {
  const listBox = list.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()
  if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top + 4
  else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom + 4
}

function frameDetailOfSelected() {
  if (state.selectedFrame === null) return null
  const entry = entries()[state.selectedFrame]
  if (!entry) return null
  return frameDetail(entry)
}

/* ------------------------------------------------------------------------ */
/* markdown lab                                                             */
/* ------------------------------------------------------------------------ */

function handleLabInput(options = {}) {
  dom.labCount.textContent = `${codePointLength(dom.labInput.value)} 字符`
  if (labTimer) {
    clearTimeout(labTimer)
    labTimer = null
  }
  if (options.immediate) {
    void renderLab()
    return
  }
  labTimer = setTimeout(() => {
    labTimer = null
    void renderLab()
  }, LAB_DEBOUNCE_MS)
}

/** `seq` guards against a slow /api/normalize reply landing after newer input. */
async function renderLab() {
  const seq = ++labRequestId
  const source = dom.labInput.value
  let output = source
  let notes = []

  if (dom.normalizeToggle.checked) {
    try {
      const response = await apiFetch(
        '/api/normalize',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: source, normalize: true }),
        },
        8000,
      )
      if (!response.ok) throw new Error(await httpErrorText(response))
      const payload = await response.json()
      if (seq !== labRequestId) return
      if (typeof payload?.output === 'string') output = payload.output
      notes = Array.isArray(payload?.notes) ? payload.notes.filter((note) => typeof note === 'string') : []
    } catch (error) {
      if (seq !== labRequestId) return
      notes = [`规范化请求失败（${errorMessage(error)}），已按原文渲染。`]
    }
  }

  if (seq !== labRequestId) return
  if (notes.length) {
    dom.labNotes.textContent = notes.join('\n')
    dom.labNotes.hidden = false
  } else {
    dom.labNotes.textContent = ''
    dom.labNotes.hidden = true
  }
  mdInto(dom.labPreview, output)
}

function loadSelectedIntoLab() {
  if (state.selectedFrame === null) return
  const detail = frameDetailOfSelected()
  if (!detail || !detail.raw.trim()) {
    showStatus('该帧没有可渲染的正文，换个 card-frame / markdown / text 试试。', 'warn', 4000)
    return
  }
  dom.labInput.value = detail.raw
  handleLabInput({ immediate: true })
  dom.labPanel.open = true
  dom.labPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  showStatus(`已把第 ${state.selectedFrame + 1} 帧载入实验室。`, 'ok', 3000)
}

/* ------------------------------------------------------------------------ */
/* activity gallery                                                         */
/* ------------------------------------------------------------------------ */

async function loadGallery() {
  if (state.galleryLoaded) return
  dom.galleryBody.replaceChildren(el('p', 'empty', '加载中…'))
  try {
    const response = await apiFetch('/api/activity-lines', undefined, 8000)
    if (!response.ok) throw new Error(await httpErrorText(response))
    const payload = await response.json()
    state.galleryLoaded = true
    renderGallery(payload)
  } catch (error) {
    dom.galleryBody.replaceChildren(
      el('p', 'empty', `活动行画廊不可用：${errorMessage(error)}。启动「pnpm run playground」后重新展开。`),
    )
  }
}

/** One copyable raw line; `label` turns it into a labelled row (思考/完成/失败). */
function processLine(text, label) {
  const button = el('button', 'process-line', text)
  button.type = 'button'
  button.title = '点击复制这一行的原文'
  button.addEventListener('click', () => void copyText(text, button))
  if (!label) return button
  const row = el('div', 'process-row')
  row.append(el('span', 'process-label', label), button)
  return row
}

function processState(label, copyLines, fill) {
  const wrap = el('div', 'process-state')
  const bar = el('div', 'process-state-head')
  bar.append(el('span', 'process-tag', label))
  const copy = el('button', 'btn btn-mini', '复制整块')
  copy.type = 'button'
  copy.title = '复制这一块的全部原始行'
  copy.addEventListener('click', () => void copyText(copyLines.join('\n'), copy))
  bar.append(copy)
  wrap.append(bar)

  const block = el('div', 'process-block')
  fill(block)
  wrap.append(block)
  return wrap
}

/**
 * DSH compact-mode process line: one plain paragraph above the card body while
 * the turn runs, and the single folded summary line that replaces it afterwards.
 * Deliberately one paragraph with at most one icon: a real DingTalk device puts
 * a full paragraph gap between blocks, so per-step rows cost half a screen.
 * Returns null for older payloads so the gallery keeps its previous shape.
 */
function renderProcessBlock(process) {
  const textOf = (value) => (typeof value === 'string' && value.trim() ? value : '')
  const todo = textOf(process?.todo)
  const line = textOf(process?.line)
  const thinking = textOf(process?.thinking)
  const settled = textOf(process?.settled)
  const failed = textOf(process?.failed)
  if (!todo && !line && !thinking && !settled && !failed) return null

  const section = el('section', 'gallery-process')
  const head = el('div', 'gallery-process-head')
  head.append(el('h3', 'gallery-process-title', '过程线'))
  head.append(el('span', 'panel-meta', 'process'))
  section.append(head)

  const note = el('p', 'gallery-note')
  note.append(
    '面板里渲染的是真实 ',
    el('code', undefined, 'renderProcessLine'),
    ' / ',
    el('code', undefined, 'renderProcessSettled'),
    ' 输出（与钉钉卡片逐字节一致）。点一下即可复制原文。',
  )
  section.append(note)

  if (todo || line || thinking) {
    section.append(
      processState('进行中', [todo, line, thinking].filter(Boolean), (block) => {
        if (todo) block.append(processLine(todo, '任务'))
        if (line) block.append(processLine(line, '工具'))
        if (thinking) block.append(processLine(thinking, '思考'))
      }),
    )
  }

  if (settled || failed) {
    section.append(
      processState('回答结束后', [settled, failed].filter(Boolean), (block) => {
        if (settled) block.append(processLine(settled, '完成'))
        if (failed) block.append(processLine(failed, '失败'))
      }),
    )
  }

  return section
}

function renderGallery(payload) {
  const groups = Array.isArray(payload?.groups) ? payload.groups.filter(isObject) : []
  dom.galleryBody.replaceChildren()

  const processBlock = isObject(payload?.process) ? renderProcessBlock(payload.process) : null
  if (processBlock) dom.galleryBody.append(processBlock)

  const thinking = asText(payload?.thinking, '')
  if (thinking) {
    const row = el('div', 'gallery-thinking')
    row.append(el('span', undefined, thinking))
    const copy = el('button', 'btn btn-mini', '复制')
    copy.type = 'button'
    copy.addEventListener('click', () => void copyText(thinking, copy))
    row.append(copy)
    dom.galleryBody.append(row)
  }

  if (!groups.length) {
    dom.galleryBody.append(el('p', 'empty', '画廊为空。'))
    return
  }

  const table = el('table', 'gallery-table')
  const thead = el('thead')
  const headRow = el('tr')
  for (const label of ['variant', 'running', 'done', 'error', 'stopped']) headRow.append(el('th', undefined, label))
  thead.append(headRow)

  const tbody = el('tbody')
  for (const group of groups) {
    const row = el('tr')
    row.append(el('td', undefined, `${asText(group.variant, '?')}\n${asText(group.sample, '')}`))
    for (const stateName of ['running', 'done', 'error', 'stopped']) {
      const line = typeof group.lines?.[stateName] === 'string' ? group.lines[stateName] : ''
      const cell = el('td')
      const button = el('button', 'gallery-cell', line)
      button.type = 'button'
      button.title = '点击复制原始行'
      button.addEventListener('click', () => void copyText(line, button))
      cell.append(button)
      row.append(cell)
    }
    tbody.append(row)
  }

  table.append(thead, tbody)
  dom.galleryBody.append(table)
}

/* ------------------------------------------------------------------------ */
/* clipboard                                                                */
/* ------------------------------------------------------------------------ */

function flashButton(button, label) {
  const original = button.dataset.originalLabel ?? button.textContent
  button.dataset.originalLabel = original
  button.textContent = label
  const previous = flashTimers.get(button)
  if (previous) clearTimeout(previous)
  flashTimers.set(
    button,
    setTimeout(() => {
      button.textContent = original
      flashTimers.delete(button)
    }, 1100),
  )
}

function legacyCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

async function copyText(text, button) {
  if (!text) {
    showStatus('没有可复制的内容。', 'warn', 2500)
    return
  }
  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {
    copied = legacyCopy(text)
  }
  if (copied) {
    if (button) flashButton(button, '已复制')
    return
  }
  showStatus('复制失败：请手动选中文本后按 ⌘/Ctrl + C。', 'error')
}

/* ------------------------------------------------------------------------ */
/* status bar                                                               */
/* ------------------------------------------------------------------------ */

function showStatus(message, kind = 'info', autoHideMs = 0) {
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  dom.statusText.textContent = message
  dom.statusBar.dataset.kind = kind
  dom.statusBar.hidden = false
  if (autoHideMs > 0) statusTimer = setTimeout(hideStatus, autoHideMs)
}

function hideStatus() {
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  dom.statusBar.hidden = true
}

/* ------------------------------------------------------------------------ */
/* settings + preferences                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Recorder options in effect: the selected scenario's defaults, with only the
 * author's manual overrides on top. `lifecycle` stays global because it is a
 * transport strategy, not scenario semantics.
 */
function effectiveSettings() {
  return {
    replyMode: state.overrides.replyMode ?? state.scenarioDefaults.replyMode,
    lifecycle: state.settings.lifecycle,
    throttleMs: state.overrides.throttleMs ?? state.scenarioDefaults.throttleMs,
    maxCardChars: state.overrides.maxCardChars ?? state.scenarioDefaults.maxCardChars,
    conversationType: state.overrides.conversationType ?? state.scenarioDefaults.conversationType,
  }
}

/** `/api/scenarios` carries per-scenario `defaults`; metadata is the fallback. */
function scenarioDefaultsOf(scenario) {
  const defaults = isObject(scenario?.defaults) ? scenario.defaults : {}
  return {
    replyMode: pick(defaults.replyMode, REPLY_MODES, scenario?.mode ?? DEFAULT_SETTINGS.replyMode),
    throttleMs: clampNumber(defaults.throttleMs, 1, 10000, DEFAULT_SETTINGS.throttleMs),
    maxCardChars: clampNumber(defaults.maxCardChars, 200, 20000, DEFAULT_SETTINGS.maxCardChars),
    conversationType: pick(
      defaults.conversationType,
      CONVERSATION_TYPES,
      scenario?.conversationType ?? DEFAULT_SETTINGS.conversationType,
    ),
  }
}

/**
 * Adopt a scenario's defaults. Manual overrides survive a re-run of the SAME
 * scenario (otherwise tweaking maxCardChars and pressing its card would silently
 * undo the tweak) but are dropped when the scenario actually switches.
 */
function applyScenarioDefaults(scenario) {
  if (!scenario) return
  const switched = state.currentScenarioId !== scenario.id
  state.currentScenarioId = scenario.id
  state.scenarioDefaults = scenarioDefaultsOf(scenario)
  if (switched) state.overrides = {}
  syncSettingsInputs()
  updateSettingsDirty()
}

function readFieldValue(field, input) {
  if (field === 'replyMode') return pick(input.value, REPLY_MODES, state.scenarioDefaults.replyMode)
  if (field === 'conversationType')
    return pick(input.value, CONVERSATION_TYPES, state.scenarioDefaults.conversationType)
  if (field === 'throttleMs') return clampNumber(input.value, 1, 10000, state.scenarioDefaults.throttleMs)
  return clampNumber(input.value, 200, 20000, state.scenarioDefaults.maxCardChars)
}

function onSettingChanged(field) {
  if (field === 'lifecycle') {
    state.settings.lifecycle = pick(dom.setLifecycle.value, LIFECYCLES, DEFAULT_SETTINGS.lifecycle)
  } else {
    const value = readFieldValue(field, settingInputs[field])
    // Setting a field back to the scenario default is how an override is cleared.
    if (String(value) === String(state.scenarioDefaults[field])) delete state.overrides[field]
    else state.overrides[field] = value
  }
  syncSettingsInputs()
  savePrefs()
  updateSettingsDirty()
}

function syncSettingsInputs() {
  const effective = effectiveSettings()
  dom.setReplyMode.value = effective.replyMode
  dom.setLifecycle.value = effective.lifecycle
  dom.setThrottleMs.value = String(effective.throttleMs)
  dom.setMaxCardChars.value = String(effective.maxCardChars)
  dom.setConversationType.value = effective.conversationType
  updateFieldBadges()
}

/** Show where each value comes from, so a scenario default is never mistaken for a bug. */
function updateFieldBadges() {
  for (const field of ['replyMode', 'throttleMs', 'maxCardChars', 'conversationType']) {
    const badge = dom.settingBadges[field]
    if (!badge) continue
    const overridden = Object.prototype.hasOwnProperty.call(state.overrides, field)
    badge.textContent = overridden ? '已手动覆盖' : '剧本默认'
    badge.classList.toggle('is-override', overridden)
  }
  const lifecycleBadge = dom.settingBadges.lifecycle
  if (lifecycleBadge) lifecycleBadge.textContent = '全局偏好'
}

/** A setting only affects the next recording, so tell the author to re-run. */
function updateSettingsDirty() {
  const effective = effectiveSettings()
  const dirty = Object.keys(DEFAULT_SETTINGS).some(
    (key) => String(effective[key]) !== String(state.appliedSettings[key]),
  )
  dom.dirtyHint.hidden = !dirty
}

/** Annotation state is DOM-only: an outline never participates in layout. */
function applyShellAnnotation() {
  document.body.classList.toggle('annotate-shell', state.shell)
  dom.shellToggle.setAttribute('aria-pressed', String(state.shell))
  dom.shellLegend.hidden = !state.shell
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme
  for (const button of dom.themeGroup.querySelectorAll('[data-theme-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeValue === state.theme))
  }
}

function setTheme(theme) {
  state.theme = pick(theme, ['light', 'dark'], 'light')
  applyTheme()
  savePrefs()
}

function applyDevice() {
  dom.deviceFrame.dataset.device = state.device
  // The stylesheet owns the pixel widths; the attribute only picks a size class.
  for (const button of dom.deviceGroup.querySelectorAll('[data-device]')) {
    button.setAttribute('aria-pressed', String(button.dataset.device === state.device))
  }
}

function setDevice(device) {
  state.device = pick(device, ['mobile', 'desktop'], 'mobile')
  applyDevice()
  savePrefs()
  updateDeviceHint()
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: state.theme,
        device: state.device,
        speed: state.speed,
        shell: state.shell,
        lifecycle: state.settings.lifecycle,
      }),
    )
  } catch {
    // Private mode / file:// — preferences are a convenience, not a feature.
  }
}

function loadPrefs() {
  let saved = null
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')
  } catch {
    saved = null
  }
  if (!isObject(saved)) return
  state.theme = pick(saved.theme, ['light', 'dark'], state.theme)
  state.shell = saved.shell === true
  state.device = pick(saved.device, ['mobile', 'desktop'], state.device)
  const speed = Number(saved.speed)
  if ([0.5, 1, 2, 4].includes(speed)) state.speed = speed
  // `saved.settings` is the pre-defaults shape; keep reading it so an older
  // profile does not lose its lifecycle choice.
  const legacy = isObject(saved.settings) ? saved.settings : {}
  state.settings.lifecycle = pick(saved.lifecycle ?? legacy.lifecycle, LIFECYCLES, state.settings.lifecycle)
}

/* ------------------------------------------------------------------------ */
/* scenarios + running                                                      */
/* ------------------------------------------------------------------------ */

function renderScenarioOptions() {
  const options = [...state.scenarios]
  const current = state.result?.scenario
  if (current && !options.some((scenario) => scenario.id === current.id)) {
    options.unshift({ id: current.id, title: `${current.title}（当前）` })
  }
  dom.scenarioSelect.replaceChildren()
  for (const scenario of options) {
    const option = el('option', undefined, scenario.title || scenario.id)
    option.value = scenario.id
    dom.scenarioSelect.append(option)
  }
  dom.scenarioSelect.value = current?.id ?? options[0]?.id ?? ''
}

function renderScenarios() {
  dom.scenarioList.replaceChildren()
  const activeId = state.result?.scenario?.id

  for (const scenario of state.scenarios) {
    const item = el('li')
    const button = el('button', 'scenario')
    button.type = 'button'
    button.append(el('span', 'scenario-title', scenario.title))
    if (scenario.description) button.append(el('span', 'scenario-desc', scenario.description))

    const tags = el('span', 'scenario-tags')
    for (const label of scenario.tags) tags.append(el('span', 'tag', label))
    if (!scenario.tags.length) {
      tags.append(el('span', 'tag', scenario.mode))
      tags.append(el('span', 'tag', scenario.conversationType === 'group' ? '群聊' : '单聊'))
    }
    button.append(tags)

    button.classList.toggle('is-active', scenario.id === activeId)
    button.addEventListener('click', () => {
      dom.scenarioSelect.value = scenario.id
      applyScenarioDefaults(scenario)
      void runScenario(scenario.id, { autoplay: true })
    })
    item.append(button)
    dom.scenarioList.append(item)
  }

  if (!state.scenarios.length) {
    dom.scenarioList.append(el('li', 'empty', '剧本列表为空。'))
  }
  dom.scenarioCount.textContent = state.scenarios.length ? `${state.scenarios.length} 个` : ''
}

async function loadScenarios(options = {}) {
  try {
    const response = await apiFetch('/api/scenarios', undefined, 6000)
    if (!response.ok) throw new Error(await httpErrorText(response))
    const payload = await response.json()
    const list = Array.isArray(payload?.scenarios) ? payload.scenarios.map(normalizeScenario) : []
    if (!list.length) throw new Error('剧本列表为空')
    state.scenarios = list.filter((scenario) => scenario.id)
    state.offline = false
    renderScenarioOptions()
    renderScenarios()
    return true
  } catch (error) {
    state.offline = true
    state.scenarios = [
      {
        id: 'offline-fixture',
        title: '离线示例（fixture）',
        description: '未连接 playground 服务，直接回放 fixtures/demo-run.json',
        tags: ['离线'],
        mode: DEFAULT_SETTINGS.replyMode,
        conversationType: DEFAULT_SETTINGS.conversationType,
        defaults: null,
      },
    ]
    renderScenarioOptions()
    renderScenarios()
    if (!options.silent) {
      showStatus(
        `无法连接 playground 服务（${errorMessage(error)}），已切换到离线 fixture。运行「pnpm run playground」后可录制真实剧本。`,
        'warn',
      )
    }
    return false
  }
}

function runBody(scenarioId) {
  // Send ONLY manual overrides: everything else must fall through to the
  // scenario's own defaults (rollover and markdown modes depend on them).
  const options = { pace: 1, lifecycle: state.settings.lifecycle }
  for (const field of ['replyMode', 'conversationType', 'maxCardChars', 'throttleMs']) {
    if (Object.prototype.hasOwnProperty.call(state.overrides, field)) options[field] = state.overrides[field]
  }
  return { scenarioId, options }
}

function setRunning(running) {
  state.running = running
  dom.runBtn.disabled = running
  dom.runBtn.classList.toggle('is-busy', running)
  dom.runBtn.textContent = running ? '录制中…' : '运行'
  if (running && !dom.messageList.querySelector('.msg-row')) showChatSkeleton()
}

/** Skeleton only when there is nothing to keep; a re-run should not blank the chat. */
function showChatSkeleton() {
  resetTranscript()
  for (let index = 0; index < 3; index += 1) {
    const row = el('div', `skeleton-row${index === 0 ? ' skeleton-me' : ''}`)
    row.append(el('div', 'skeleton-avatar'), el('div', 'skeleton-bubble'))
    dom.messageList.append(row)
  }
}

function applyResult(raw, options = {}) {
  const result = normalizeResult(raw)
  const effective = effectiveSettings()
  pausePlayback()
  state.result = result
  state.index = 0
  state.appliedSettings = {
    replyMode: pick(result.options?.replyMode, REPLY_MODES, effective.replyMode),
    lifecycle: pick(result.options?.lifecycle, LIFECYCLES, effective.lifecycle),
    throttleMs: asCount(result.options?.throttleMs, effective.throttleMs),
    maxCardChars: asCount(result.options?.maxCardChars, effective.maxCardChars),
    conversationType: pick(result.options?.conversationType, CONVERSATION_TYPES, effective.conversationType),
  }
  updateSettingsDirty()

  updateChatHeader()
  renderScenarioOptions()
  renderScenarios()
  dom.frameStats.textContent = `${result.stats.entries} 条 · ${result.stats.frames} 帧 · ${result.stats.cards} 卡`
  renderFrames()
  clearFrameDetail()

  rebuild(options.autoplay ? 0 : result.timeline.length)
  if (options.autoplay) {
    state.playing = true
    syncPlayback()
    scheduleNext()
  }
}

async function runScenario(scenarioId, options = {}) {
  if (state.running || !scenarioId) return
  const autoplay = options.autoplay !== false
  // Offline recovery can hand us a scenario the settings panel has never seen.
  const scenario = state.scenarios.find((item) => item.id === scenarioId)
  if (scenario && state.currentScenarioId !== scenario.id) applyScenarioDefaults(scenario)
  setRunning(true)
  hideStatus()

  try {
    if (state.offline) throw new Error('playground 服务未启动')
    const response = await apiFetch(
      '/api/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runBody(scenarioId)),
      },
      30000,
    )
    if (!response.ok) throw new Error(await httpErrorText(response))
    const payload = await response.json()
    if (!Array.isArray(payload?.timeline)) throw new Error('响应缺少 timeline')

    applyResult(payload, { autoplay })
    // Always restate THIS recording: the previous run's summary must not linger.
    const resolved = isObject(payload.options) ? payload.options : {}
    const effective = effectiveSettings()
    showStatus(
      `已录制 ${state.result.stats.entries} 条时间线 / ${state.result.stats.cards} 张卡片` +
        `（lifecycle: ${asText(resolved.lifecycle, effective.lifecycle)}，replyMode: ${asText(resolved.replyMode, effective.replyMode)}）。` +
        '点 ⏮ 回到开头，空格播放。',
      'ok',
      9000,
    )
  } catch (error) {
    showStatus(`运行失败：${errorMessage(error)}。已回落到 fixtures/demo-run.json。`, 'error')
    await loadFixture({ autoplay })
  } finally {
    setRunning(false)
  }
}

async function loadFixture(options = {}) {
  const autoplay = options.autoplay !== false
  try {
    const response = await apiFetch(FIXTURE_URL, undefined, 8000)
    if (!response.ok) throw new Error(await httpErrorText(response))
    const payload = await response.json()
    if (!Array.isArray(payload?.timeline)) throw new Error('fixture 缺少 timeline')
    applyResult(payload, { autoplay })
    return true
  } catch (error) {
    applyResult(BUILTIN_RUN, { autoplay })
    if (state.offline) {
      showStatus(`fixture 不可用（${errorMessage(error)}），已改用内置示例 timeline。`, 'warn')
    }
    return false
  }
}

/** Offline runs first retry discovery, so starting the server later is picked up. */
async function runCurrentSelection() {
  if (state.running) return
  if (state.offline) {
    const recovered = await loadScenarios({ silent: true })
    if (!recovered) {
      await loadFixture({ autoplay: true })
      return
    }
  }
  await runScenario(dom.scenarioSelect.value, { autoplay: true })
}

function updateChatHeader() {
  const conversation = state.result?.conversation
  if (!conversation) {
    dom.chatTitle.textContent = 'DeepSeek Harness'
    return
  }
  const base = conversation.title || conversation.robotName || 'DeepSeek Harness'
  // Group titles already carry the member count (`前端体验打磨(12)`); only add one
  // when the scenario did not provide it.
  const hasCount = /[(（]\s*\d+\s*[)）]\s*$/.test(base)
  dom.chatTitle.textContent = conversation.type === 'group' && !hasCount ? `${base}(3)` : base
}

async function bootstrapTranscript() {
  if (state.offline || !state.scenarios.length) {
    await loadFixture({ autoplay: false })
    return
  }
  applyScenarioDefaults(state.scenarios[0])
  await runScenario(state.scenarios[0].id, { autoplay: false })
}

/* ------------------------------------------------------------------------ */
/* bindings + init                                                          */
/* ------------------------------------------------------------------------ */

function isEditableTarget(node) {
  if (!(node instanceof Element)) return false
  return node.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function bindUi() {
  dom.runBtn.addEventListener('click', () => void runCurrentSelection())
  dom.resetBtn.addEventListener('click', resetPlayback)
  dom.playBtn.addEventListener('click', togglePlayback)
  dom.stepBtn.addEventListener('click', singleStep)

  dom.progress.addEventListener('input', () => {
    // Read the slider before pausing: pausePlayback() resyncs it from state.index
    // and would otherwise turn every scrub into a no-op.
    const target = Number(dom.progress.value)
    pausePlayback()
    rebuild(target)
  })

  dom.speedGroup.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-speed]') : null
    if (button) setSpeed(Number(button.dataset.speed))
  })

  for (const [field, input] of Object.entries(settingInputs)) {
    input.addEventListener('change', () => onSettingChanged(field))
  }

  dom.scenarioSelect.addEventListener('change', () => {
    const scenario = state.scenarios.find((item) => item.id === dom.scenarioSelect.value)
    applyScenarioDefaults(scenario)
  })

  dom.shellToggle.addEventListener('click', () => {
    state.shell = !state.shell
    applyShellAnnotation()
    savePrefs()
  })

  dom.themeGroup.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-theme-value]') : null
    if (button) setTheme(button.dataset.themeValue)
  })

  dom.deviceGroup.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-device]') : null
    if (button) setDevice(button.dataset.device)
  })

  dom.statusClose.addEventListener('click', hideStatus)
  dom.labInput.addEventListener('input', () => handleLabInput())
  dom.normalizeToggle.addEventListener('change', () => handleLabInput({ immediate: true }))
  dom.galleryPanel.addEventListener('toggle', () => {
    if (dom.galleryPanel.open) void loadGallery()
  })

  dom.jumpBtn.addEventListener('click', () => {
    if (state.selectedFrame === null) return
    pausePlayback()
    rebuild(state.selectedFrame + 1)
  })
  dom.copyFrameBtn.addEventListener('click', () => {
    const detail = frameDetailOfSelected()
    if (detail) void copyText(detail.raw, dom.copyFrameBtn)
  })
  dom.loadLabBtn.addEventListener('click', loadSelectedIntoLab)
  setFrameActionsEnabled(false)

  document.addEventListener('click', (event) => {
    if (!dom.settingsPopover.open) return
    if (event.target instanceof Node && dom.settingsPopover.contains(event.target)) return
    dom.settingsPopover.open = false
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dom.settingsPopover.open) {
      dom.settingsPopover.open = false
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isEditableTarget(event.target)) return
    if (event.code === 'Space') {
      event.preventDefault()
      togglePlayback()
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      stepBack()
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      singleStep()
    }
  })
}

async function init() {
  loadPrefs()
  applyTheme()
  applyDevice()
  applyShellAnnotation()
  syncSettingsInputs()
  bindUi()
  syncPlayback()
  updateSettingsDirty()
  dom.labInput.value = LAB_SAMPLE
  handleLabInput({ immediate: true })
  await loadScenarios()
  await bootstrapTranscript()
}

void init().catch((error) => {
  showStatus(`初始化失败：${errorMessage(error)}`, 'error')
})
