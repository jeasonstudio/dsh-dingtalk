/**
 * One live-turn activity line: the single short status the AI Card shows while
 * the agent works. It mirrors the DSH web client's tool-row model — wire-name
 * variant, args-derived summary, run state — so DingTalk shows the same wording
 * shape as `dsh web` rather than appending a permanent `⚙️ <wire name> ✓` line
 * for every call.
 *
 * The AI Card is a full-overwrite streaming canvas (`isFull: true`), so the
 * renderer recomputes this line on every event: a newer activity REPLACES the
 * previous one, and the turn's tool history never accumulates in the card.
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
  if (activity.kind === 'thinking') return '> 💭 正在思考…'
  const phrase = PHRASES[activity.variant][activity.state]
  const detail = activity.summary ? ` · ${activity.summary}` : ''
  return `> ${ICONS[activity.state]} ${phrase}${detail}`
}
