/**
 * One live-turn activity line: the single short status the AI Card shows while
 * the agent works. It mirrors the DSH web client's tool-row model — wire-name
 * variant, args-derived summary, run state — so DingTalk shows the same wording
 * shape as `dsh web` rather than appending a permanent `⚙️ <wire name> ✓` line
 * for every call.
 *
 * The AI Card is a full-overwrite streaming canvas (`isFull: true`), so the
 * renderer recomputes the whole card on every event: the step rows are kept in
 * turn state and composed into one process line (see `renderProcessLine`), never
 * appended to the card one by one.
 */

/** DSH tool families the web client renders with a dedicated row variant. */
export type ActivityVariant =
  'bash' | 'read' | 'write' | 'edit' | 'search' | 'fetch' | 'code' | 'todo' | 'ask' | 'skill' | 'present' | 'other'

/** Latest visible tool activity in the current turn. */
export interface ToolActivity {
  readonly kind: 'tool'
  /** Wire tool name (what `tool/call` reports). */
  readonly name: string
  readonly variant: ActivityVariant
  readonly callId?: string
  /** Salient argument summary: command / description / path / pattern / url. */
  summary?: string
  state: 'running' | 'done' | 'error' | 'stopped'
}

/** Latest visible activity for the live card: thinking, or one tool call. */
export type LiveActivity = { readonly kind: 'thinking' } | ToolActivity

/** Wire tool name -> DSH presentation variant (mirrors the web client's table). */
const VARIANTS: Record<string, ActivityVariant> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'edit',
  str_replace_editor: 'edit',
  grep: 'search',
  glob: 'search',
  web_search: 'search',
  web_fetch: 'fetch',
  run_code: 'code',
  todo_write: 'todo',
  ask_user_question: 'ask',
  skill: 'skill',
  present: 'present',
}

/** Localized row phrases; the state selects the tense. */
const PHRASES: Record<ActivityVariant, { running: string; done: string; error: string; stopped: string }> = {
  bash: { running: '正在执行命令', done: '已执行命令', error: '执行命令失败', stopped: '执行命令已停止' },
  read: { running: '正在读取文件', done: '已读取文件', error: '读取文件失败', stopped: '读取文件已停止' },
  write: { running: '正在写入文件', done: '已写入文件', error: '写入文件失败', stopped: '写入文件已停止' },
  edit: { running: '正在编辑文件', done: '已编辑文件', error: '编辑文件失败', stopped: '编辑文件已停止' },
  search: { running: '正在搜索', done: '已搜索', error: '搜索失败', stopped: '搜索已停止' },
  fetch: { running: '正在获取网页', done: '已获取网页', error: '获取网页失败', stopped: '获取网页已停止' },
  code: { running: '正在运行代码', done: '已运行代码', error: '运行代码失败', stopped: '运行代码已停止' },
  todo: {
    running: '正在更新任务清单',
    done: '已更新任务清单',
    error: '更新任务清单失败',
    stopped: '更新任务清单已停止',
  },
  ask: { running: '正在向你提问', done: '已向你提问', error: '提问失败', stopped: '提问已停止' },
  skill: { running: '正在加载技能', done: '已加载技能', error: '加载技能失败', stopped: '加载技能已停止' },
  present: { running: '正在交付文件', done: '已交付文件', error: '交付文件失败', stopped: '交付文件已停止' },
  other: { running: '正在调用工具', done: '已调用工具', error: '调用工具失败', stopped: '调用工具已停止' },
}

const ICONS = { running: '⚙️', done: '✅', error: '❌', stopped: '⏹️' } as const

/**
 * Summary preference per variant, mirroring the web client: bash prefers the
 * model-authored `description` (semantic) and falls back to the command.
 */
const SUMMARY_KEYS: Record<ActivityVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  search: ['query', 'pattern', 'url'],
  fetch: ['url'],
  code: ['description'],
  todo: [],
  ask: ['header', 'question'],
  skill: ['name'],
  present: ['path', 'title', 'name'],
  other: [],
}

const MAX_SUMMARY = 80

/** Collapse whitespace and clamp a summary to one short line. */
function truncate(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length > MAX_SUMMARY ? `${chars.slice(0, MAX_SUMMARY - 1).join('')}…` : line
}

/**
 * Derive the salient argument summary the same way the DSH web client does.
 * Deliberately narrow: only the documented per-variant keys (plus
 * `web_search.queries`) may surface, so an arbitrary argument (file contents,
 * a token, a prompt) is never copied onto a card visible in the chat.
 */
function deriveSummary(variant: ActivityVariant, argsRaw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const args = parsed as Record<string, unknown>
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === 'string' && query.trim() !== '')
    if (queries.length > 0) return truncate(queries.join(', '))
  }
  for (const key of SUMMARY_KEYS[variant]) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return truncate(value)
  }
  return ''
}

/** Classify one `tool/call` (or PTC sub-dispatch) event into the activity line. */
export function describeToolCall(name: string, argsRaw: unknown, callId?: string): ToolActivity {
  const variant = VARIANTS[name] ?? 'other'
  const summary =
    variant === 'other'
      ? ''
      : typeof argsRaw === 'string'
        ? deriveSummary(variant, argsRaw)
        : typeof argsRaw === 'object' && argsRaw !== null
          ? deriveSummary(variant, JSON.stringify(argsRaw))
          : ''
  return {
    kind: 'tool',
    name,
    variant,
    ...(callId !== undefined ? { callId } : {}),
    state: 'running',
    // Unknown tools show their wire name only (never an unreviewed argument).
    ...(variant === 'other' ? { summary: name } : summary ? { summary } : {}),
  }
}

/** Render the current activity as one markdown blockquote line. */
export function renderActivityLine(activity: LiveActivity): string {
  if (activity.kind === 'thinking') return '> 💭 正在分析请求'
  const phrase = PHRASES[activity.variant][activity.state]
  const detail = activity.summary ? ` · ${activity.summary}` : ''
  return `> ${ICONS[activity.state]} ${phrase}${detail}`
}

/**
 * Process line: the DSH web client's "工作步骤" group, compressed to ONE line.
 *
 * DSH 简洁 mode shows an expanded list of step rows while the turn runs and folds
 * it into a single header once the answer is done. A DingTalk card cannot fold,
 * and it also cannot spend vertical space on the work log: a real device renders
 * every separate paragraph (and every blockquote block) with a full paragraph
 * gap, so a six-row list became half a screen of checkmarks. The card therefore
 * renders the same information as one paragraph — the step in flight, a short
 * breadcrumb of what already finished, and the elapsed time — and the folded
 * header once the turn settles. One emoji at most, no blockquote: it reads like
 * a status sentence instead of a wall of icons.
 */

/** Breadcrumb items kept on the live line; older steps fold into the count. */
export const MAX_PROCESS_ITEMS = 2

/** Summary length inside the breadcrumb: the line must stay readable inline. */
const ITEM_SUMMARY = 16

/**
 * The turn's todo list, reduced to what a card can show: the item in flight and
 * how far the list has got. Derived from the durable `todo/write` snapshot, so
 * the line survives a roll-over without replaying tool arguments.
 */
export interface TodoSnapshot {
  /** `content` of the first `in_progress` item. */
  readonly active: string
  /** Finished items. */
  readonly done: number
  /** Total items in the list. */
  readonly total: number
  /** Further `in_progress` items (parallel work); 0 or 1 in the common case. */
  readonly alsoActive: number
}

export type TurnOutcome = 'completed' | 'failed' | 'stopped'

/**
 * Read the `todos` payload of a `todo/write` event. Returns undefined when the
 * list is gone or nothing is in flight — the card only ever shows the task being
 * worked on, never the whole checklist.
 */
export function todoSnapshot(todos: unknown): TodoSnapshot | undefined {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const items = todos.filter(
    (item): item is { content: string; status: string } =>
      !!item && typeof item === 'object' && typeof (item as any).content === 'string',
  )
  const active = items.filter((item) => item.status === 'in_progress')
  if (active.length === 0) return undefined
  return {
    active: active[0].content,
    done: items.filter((item) => item.status === 'completed').length,
    total: items.length,
    alsoActive: active.length - 1,
  }
}

/**
 * The todo line above the process line: `📋 任务进行中：压成一行过程线（2/5）`.
 * Only the item in flight is shown, and the fraction counts finished items —
 * the same shape as DSH's todo progress, compressed into one paragraph.
 */
export function renderTodoLine(todo: TodoSnapshot | undefined): string {
  if (!todo) return ''
  const extra = todo.alsoActive > 0 ? ` 等 ${todo.alsoActive + 1} 项` : ''
  return `📋 任务进行中：${truncateTo(todo.active, 28)}${extra}（${todo.done}/${todo.total}）`
}

export interface ProcessSnapshot {
  /** Tool steps in arrival order; the last one may still be running. */
  steps: readonly ToolActivity[]
  /** Accumulated reasoning time (ms). */
  thinkingMs: number
  /** True while the model is still reasoning. */
  thinking: boolean
  /** Whole-turn elapsed time (ms). */
  elapsedMs: number
}

/**
 * Short verb for the inline breadcrumb: no 已/了 prefix, no icon. The full row
 * wording (renderActivityLine) stays the single-step vocabulary.
 */
const BREADCRUMB: Record<ActivityVariant, string> = {
  bash: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  search: '搜索',
  fetch: '获取网页',
  code: '运行代码',
  todo: '更新任务清单',
  ask: '提问',
  skill: '加载技能',
  present: '交付文件',
  other: '调用工具',
}

/** `12 秒` / `1 分 05 秒`; empty under a second (too noisy to be worth the space). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ''
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${seconds.toString().padStart(2, '0')} 秒` : `${seconds} 秒`
}

/** Clamp to N characters, ellipsis included. */
function truncateTo(value: string, limit: number): string {
  const chars = [...value]
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value
}

/** One breadcrumb item: `读取文件 src/a.ts`, `执行命令失败 pnpm test`, … */
function breadcrumbItem(step: ToolActivity): string {
  const verb = BREADCRUMB[step.variant]
  const phrase = step.state === 'error' ? `${verb}失败` : step.state === 'stopped' ? `${verb}中断` : verb
  return step.summary ? `${phrase} ${truncateTo(step.summary, ITEM_SUMMARY)}` : phrase
}

/**
 * The live process line, or '' when the turn has nothing to report yet.
 * Shape: `⚙️ 正在执行命令 pnpm build · 已完成 4 步：读取文件 a.ts · 搜索 TODO 等 · 用时 23 秒`
 */
export function renderProcessLine(snapshot: ProcessSnapshot): string {
  const done = snapshot.steps.filter((step) => step.state !== 'running')
  // Newest running step wins: an older call still in flight must not shadow the
  // one the model just started.
  let running: ToolActivity | undefined
  for (let i = snapshot.steps.length - 1; i >= 0; i--) {
    if (snapshot.steps[i].state === 'running') {
      running = snapshot.steps[i]
      break
    }
  }
  const segments: string[] = []

  if (snapshot.thinking) {
    segments.push('正在分析请求')
  } else if (running) {
    const phrase = truncateTo(PHRASES[running.variant][running.state], 24)
    segments.push(running.summary ? `${phrase} ${truncateTo(running.summary, ITEM_SUMMARY)}` : phrase)
  }

  if (done.length > 0) {
    const shown = done.slice(-MAX_PROCESS_ITEMS).map(breadcrumbItem)
    const items = done.length > shown.length ? `${shown.join(' · ')} 等` : shown.join(' · ')
    segments.push(`已完成 ${done.length} 步：${items}`)
  }

  // Thinking time only stands alone: once steps are on the line the count and
  // the running step already say the turn is alive, and every extra segment
  // costs a wrapped line on a phone.
  const thought = formatDuration(snapshot.thinkingMs)
  if (!snapshot.thinking && done.length === 0 && !running && thought) segments.push(`已思考 ${thought}`)
  const took = formatDuration(snapshot.elapsedMs)
  if (took) segments.push(`用时 ${took}`)

  if (segments.length === 0) return ''
  const icon = snapshot.thinking || (!running && done.length === 0) ? '💭' : '⚙️'
  return `${icon} ${segments.join(' · ')}`
}

/**
 * Collapsed header: what DSH shows once the working steps fold away. Returns ''
 * when the turn has nothing worth folding (a fast turn with no tool call), so a
 * bare header never sits above an answer that says nothing about the work.
 */
export function renderProcessSettled(snapshot: ProcessSnapshot, outcome: TurnOutcome): string {
  const details: string[] = []
  const calls = snapshot.steps.length
  if (calls > 0) details.push(`${calls} 次工具调用`)
  else {
    const thought = formatDuration(snapshot.thinkingMs)
    if (thought) details.push(`已思考 ${thought}`)
  }
  const took = formatDuration(snapshot.elapsedMs)
  if (took) details.push(`用时 ${took}`)
  if (details.length === 0) return ''
  const tail = ` · ${details.join(' · ')}`
  if (outcome === 'failed') return `❌ 处理失败${tail}`
  if (outcome === 'stopped') return `⏹️ 任务已打断${tail}`
  return `✅ 已完成${tail}`
}
