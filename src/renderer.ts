/**
 * Outbound orchestration: one active turn per session, rendered to the
 * conversation through the configured carrier — AI Card (streaming or
 * settle-once), markdown, plain text, or asyncMode (ack now, push later).
 * Consumes the `session/event` feed; the live streaming view mirrors the DSH
 * web client's 简洁 work-step group as ONE plain paragraph (the step in flight,
 * a short breadcrumb of finished steps and the elapsed time, or the folded
 * header once the turn ends) above the accumulated `assistant/chunk` text, while
 * the settled reply prefers the clean aggregated `assistant/message` texts.
 */
import type { Config, ReplyMode } from './config.js'
import type { HostSession, HostSessionEvent } from './host.js'
import type { InboundMessage } from './stream.js'
import type { Emotion } from './emotion.js'
import type { ReplySink } from './reply-sink.js'
import { AICard, CardCapabilityError, type CardTarget } from './aicard.js'
import { cardTarget } from './targets.js'
import { describeTurnError } from './errors.js'
import {
  describeToolCall,
  renderActivityLine,
  renderProcessLine,
  renderProcessSettled,
  renderTodoLine,
  todoSnapshot,
  type ProcessSnapshot,
  type TodoSnapshot,
  type ToolActivity,
  type TurnOutcome,
} from './activity.js'

const EMPTY_MODEL_RESPONSE =
  '⚠️ **模型本次未产出正文**\n> 可能是输出额度被推理占满，请调大 `max_tokens` 或更换模型后重试。'

/**
 * A settled piece of the card, in chronological order. The card IS a transcript:
 * a work line where a burst of tools/thinking happened, then the paragraph it
 * produced, again and again, until the final answer.
 */
interface FrozenBlock {
  kind: 'work' | 'text'
  text: string
}

/** One burst of tool calls and thinking, between two text blocks. */
interface WorkBurst {
  steps: ToolActivity[]
  /** Burst start (ms), used by the live `用时`. */
  startedAt: number
  /** Reasoning time spent inside this burst (ms). */
  thinkingMs: number
}

interface TurnState {
  msg: InboundMessage
  mode: ReplyMode
  async: boolean
  /** Settled blocks: work lines and finished text, in arrival order. */
  frozen: FrozenBlock[]
  /** Text streaming after the latest settled block. */
  openText: string
  /**
   * True once a finished text block has been settled onto an earlier card. The
   * clean `assistant/message` copy must not be re-emitted on a later card, or the
   * same paragraph would appear on both.
   */
  settledTextEarlier: boolean
  /**
   * Chars of `openText` already written to the CURRENT card. A roll-over splits
   * here so the old card keeps what the reader saw and the new one only carries
   * the remainder — newer bubbles must not push a duplicate answer below them.
   */
  settledOpenText: number
  /** Work burst in flight: thinking + tool calls since the last text block. */
  burst?: WorkBurst
  /** Every step of the turn, in arrival order (call matching + totals). */
  steps: ToolActivity[]
  /** Start of the reasoning stretch in flight (ms); unset when not thinking. */
  thinkingStartedAt?: number
  /** Accumulated reasoning time of the whole turn (ms). */
  thinkingMs: number
  /** Latest `todo/write` snapshot of this turn, when a task is in flight. */
  todos?: TodoSnapshot
  /** Clean final texts from assistant/message events. */
  finalParts: string[]
  cardPromise?: Promise<AICard | null>
  flushTimer?: ReturnType<typeof setTimeout>
  lastFlushed: string
  flushing: boolean
  /**
   * A newer bubble (user message / system notice) sits below the live card;
   * the next frame rolls output over to a fresh card at the bottom.
   */
  needsRollover: boolean
  cardUnavailable: boolean
  /** Turn start (ms), used by the settled 用时 summary. */
  startedAt: number
  /** Resolves when the turn settles; the queue serializes on this. */
  settle: () => void
}

/** Paragraph separator between blocks — DingTalk renders each block with a gap. */
const BLOCK_GAP = '\n\n'

/** Join blocks top to bottom; empty blocks (a sub-second thinking burst) vanish. */
function joinBlocks(blocks: readonly FrozenBlock[]): string {
  return blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(BLOCK_GAP)
}

export interface RendererDeps {
  config: Pick<Config, 'replyMode' | 'streaming' | 'asyncMode' | 'ackText' | 'markdownTitle' | 'emotionFirstResponse'>
  outbound: ReplySink
  emotion: Emotion
  createCard(target: CardTarget): Promise<AICard | null>
  log(line: string): void
}

export class Renderer {
  private states = new Map<string, TurnState>()

  constructor(private readonly deps: RendererDeps) {}

  /**
   * Register the reply context for the turn this inbound message will drive.
   * The emotion was already added at message intake (before queueing).
   * @returns a promise resolving when the turn settles.
   */
  onInbound(sessionId: string, msg: InboundMessage): Promise<void> {
    const { config } = this.deps
    const isDirect = msg.conversationType === 'direct'
    const mode = isDirect ? config.replyMode.direct : config.replyMode.group

    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })

    const state: TurnState = {
      msg,
      mode,
      async: config.asyncMode,
      frozen: [],
      openText: '',
      settledTextEarlier: false,
      settledOpenText: 0,
      steps: [],
      thinkingMs: 0,
      startedAt: Date.now(),
      finalParts: [],
      lastFlushed: '',
      flushing: false,
      needsRollover: false,
      cardUnavailable: false,
      settle,
    }

    if (config.asyncMode) {
      // Ack now; the settled result is pushed at turn end, no streaming card.
      void this.deps.outbound.sendText(msg, config.ackText)
    } else if (mode === 'aicard') {
      state.cardPromise = this.deps.createCard(cardTarget(msg))
    }

    this.states.set(sessionId, state)
    return settled
  }

  /**
   * A new bubble entered the conversation below any live card — mark its
   * turn(s) so the next frame rolls output over to a fresh card at the bottom.
   */
  notifyInterleaved(conversationId: string): void {
    for (const st of this.states.values()) {
      if (st.msg.conversationId === conversationId && st.mode === 'aicard' && !st.async) {
        st.needsRollover = true
      }
    }
  }

  /** The burst in flight, opened by the first tool call or reasoning delta. */
  private ensureBurst(st: TurnState): WorkBurst {
    if (!st.burst) st.burst = { steps: [], startedAt: Date.now(), thinkingMs: 0 }
    return st.burst
  }

  /** Close the reasoning stretch in flight and bank its duration. */
  private closeThinking(st: TurnState): void {
    if (st.thinkingStartedAt === undefined) return
    const spent = Date.now() - st.thinkingStartedAt
    st.thinkingMs += spent
    if (st.burst) st.burst.thinkingMs += spent
    st.thinkingStartedAt = undefined
  }

  /**
   * The step a tool result belongs to. Matching is by call id only: a result
   * without one must not settle the newest running row, which would freeze a
   * still-running step as done.
   */
  private runningStep(st: TurnState, callId: string | undefined): ToolActivity | undefined {
    for (let i = st.steps.length - 1; i >= 0; i--) {
      const step = st.steps[i]
      if (step.callId === callId && step.state === 'running') return step
    }
    return undefined
  }

  /**
   * Fold the burst in flight into its one process line. Called when the model
   * starts writing: the line belongs ABOVE the paragraph it produced, so the
   * card reads like the DSH transcript (work, output, work, output).
   */
  private freezeBurst(st: TurnState): void {
    const burst = st.burst
    if (!burst) return
    // A history line never says 正在…: a step still in flight when the model moved
    // on is reported as done, and its late result simply finds nothing to update.
    for (const step of burst.steps) if (step.state === 'running') step.state = 'done'
    const line = renderProcessLine(
      { steps: burst.steps, thinkingMs: burst.thinkingMs, thinking: false, elapsedMs: Date.now() - burst.startedAt },
      { elapsed: false },
    )
    st.burst = undefined
    if (line) st.frozen.push({ kind: 'work', text: line })
  }

  /** Text that already streamed becomes a settled block before work resumes. */
  private freezeOpenText(st: TurnState): void {
    const text = st.openText.trim()
    st.openText = ''
    st.settledOpenText = 0
    if (text) st.frozen.push({ kind: 'text', text })
  }

  /** The live card as it stands: settled blocks, then the burst in flight. */
  private renderLive(st: TurnState): string {
    const blocks = [...st.frozen]
    if (st.burst) {
      const line = renderProcessLine({
        steps: st.burst.steps,
        thinkingMs: st.burst.thinkingMs,
        thinking: st.thinkingStartedAt !== undefined,
        elapsedMs: Date.now() - st.burst.startedAt,
      })
      if (line) blocks.push({ kind: 'work', text: line })
    }
    if (st.openText.trim()) blocks.push({ kind: 'text', text: st.openText.trim() })
    return joinBlocks(blocks)
  }

  /** What the card shows: the task line (turn-wide) above the transcript. */
  private cardContent(st: TurnState): string {
    return [renderTodoLine(st.todos), this.renderLive(st)].filter(Boolean).join(BLOCK_GAP)
  }

  private totalSnapshot(st: TurnState): ProcessSnapshot {
    return {
      steps: st.steps,
      thinkingMs: st.thinkingMs,
      thinking: false,
      elapsedMs: Date.now() - st.startedAt,
    }
  }

  /**
   * Settle the current card as-is (with the 输出继续 pointer) and start a fresh
   * one. Everything settled here is dropped from the turn state, so the next
   * card starts clean instead of repeating what the reader already had.
   */
  private async rollOverNow(st: TurnState, card: AICard | null): Promise<AICard | null> {
    st.needsRollover = false
    this.closeThinking(st)
    // A call still in flight continues on the next card: the settled one only
    // reports the steps that actually finished, never a 正在… row frozen in place.
    const burst = st.burst
    const carry = burst ? burst.steps.filter((step) => step.state === 'running') : []
    if (burst && carry.length > 0) burst.steps = burst.steps.filter((step) => step.state !== 'running')
    this.freezeBurst(st)
    // Split the paragraph in flight: the old card keeps what it already showed,
    // the new card carries the rest, so the answer is never written twice. A card
    // that streamed nothing yet (the first frame is already over the limit) takes
    // the whole paragraph — otherwise the split would never make progress.
    const cut = st.settledOpenText > 0 ? st.settledOpenText : st.openText.length
    const shown = st.openText.slice(0, cut).trim()
    const rest = st.openText.slice(cut)
    const blocks = [...st.frozen]
    if (shown) blocks.push({ kind: 'text', text: shown })
    const content = [renderTodoLine(st.todos), joinBlocks(blocks)].filter(Boolean).join(BLOCK_GAP)
    if (blocks.some((block) => block.kind === 'text')) st.settledTextEarlier = true
    st.frozen = []
    st.openText = rest
    st.settledOpenText = 0
    st.lastFlushed = ''
    if (carry.length > 0) st.burst = { steps: carry, startedAt: Date.now(), thinkingMs: 0 }
    st.cardPromise = this.deps.createCard(cardTarget(st.msg))
    if (card) {
      try {
        await card.finish(`${content || '…'}${BLOCK_GAP}> ⤵️ 输出继续，见下方新卡片`)
        this.deps.log('card rolled over')
      } catch (err) {
        this.deps.log(`rollover finish failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    return st.cardPromise
  }

  /**
   * The settled card: the same transcript, with the last work line folded into
   * the turn header (`✅ 已完成 · N 次工具调用 · 用时 X`) right above the answer.
   */
  private renderSettled(st: TurnState, outcome: TurnOutcome, substance: string, errText: string): string {
    this.closeThinking(st)
    this.freezeBurst(st)
    this.freezeOpenText(st)
    const blocks = [...st.frozen]

    // The clean `assistant/message` copy is authoritative: it is what the card
    // falls back to when nothing streamed (non-streaming model) and what replaces
    // the blocks when streaming lost chunks or never worked (card permission
    // error). It is skipped when an earlier card already shows that text.
    const clean = substance.trim()
    const normalise = (text: string) => text.replace(/\s+/g, '')
    const streamed = joinBlocks(blocks.filter((block) => block.kind === 'text'))
    if (clean && !st.settledTextEarlier) {
      if (!streamed) {
        blocks.push({ kind: 'text', text: clean })
      } else if (normalise(streamed) !== normalise(clean)) {
        const work = blocks.filter((block) => block.kind === 'work')
        blocks.length = 0
        blocks.push(...work, { kind: 'text', text: clean })
      }
    }

    const header = renderProcessSettled(this.totalSnapshot(st), outcome)
    if (header) {
      // Fold the last work line into the header — that is the work group right
      // above the answer that DSH collapses when the turn ends.
      let lastWork = -1
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === 'work') {
          lastWork = i
          break
        }
      }
      if (lastWork >= 0) blocks[lastWork] = { kind: 'work', text: header }
      else blocks.unshift({ kind: 'work', text: header })
    }

    if (errText) blocks.push({ kind: 'text', text: errText })
    // A card with only the header is fine after a roll-over consumed the text; a
    // turn that produced nothing at all still gets the empty-response warning. An
    // interrupted turn is not a model failure, so it never gets that warning.
    if (!errText && outcome !== 'stopped' && !blocks.some((block) => block.kind === 'text') && !substance.trim()) {
      blocks.push({ kind: 'text', text: EMPTY_MODEL_RESPONSE })
    }
    return joinBlocks(blocks)
  }

  onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    const st = this.states.get(session.id)
    if (!st) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          this.closeThinking(st)
          // Text ends the work burst: it folds into one line ABOVE this
          // paragraph, so the card keeps the DSH order (work, output, work, …).
          if (st.burst) this.freezeBurst(st)
          st.openText += chunk.text
          this.scheduleFlush(session.id, st)
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
          // Reasoning never lands in the card; it only feeds the burst line and
          // its settled duration. A late delta inside a paragraph is ignored, so
          // it cannot open a work line in the middle of the answer.
          if (st.openText.trim() === '') {
            this.ensureBurst(st)
            st.thinkingStartedAt ??= Date.now()
            this.scheduleFlush(session.id, st)
          }
        }
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        // Text before this call is a finished paragraph: freeze it so the work
        // line that follows starts its own block below it.
        this.freezeOpenText(st)
        const burst = this.ensureBurst(st)
        this.closeThinking(st)
        const step = describeToolCall(name, event.data?.arguments, event.data?.callId)
        burst.steps.push(step)
        st.steps.push(step)
        this.scheduleFlush(session.id, st)
        break
      }
      case 'tool/result': {
        const blocks = event.data?.message?.content
        const block = blocks?.[0]
        const callId = event.data?.callId ?? block?.toolCallId ?? event.data?.message?.source?.callId
        // A result for an older (or uncorrelated) call must not rewrite the row
        // of the call already running.
        const current = this.runningStep(st, callId)
        if (!current) break
        const isError = Array.isArray(blocks) && blocks.some((item: any) => item?.isError === true)
        const failure = event.data?.error ?? (isError ? { code: 'tool_error' } : undefined)
        current.state = failure?.code === 'interrupted' ? 'stopped' : failure !== undefined ? 'error' : 'done'
        this.scheduleFlush(session.id, st)
        break
      }
      // PTC mode (`run_code`) reports nested calls on their own event pair; they
      // join the same burst line so a code-mode turn is not opaque.
      case 'tool/ptc-dispatch-start': {
        this.freezeOpenText(st)
        const burst = this.ensureBurst(st)
        this.closeThinking(st)
        const step = describeToolCall(event.data?.name ?? 'tool', event.data?.arguments, event.data?.subCallId)
        burst.steps.push(step)
        st.steps.push(step)
        this.scheduleFlush(session.id, st)
        break
      }
      case 'tool/ptc-dispatch': {
        const current = this.runningStep(st, event.data?.subCallId)
        if (!current) break
        current.state = event.data?.isError === true ? 'error' : 'done'
        this.scheduleFlush(session.id, st)
        break
      }
      // Durable todo snapshot: the card shows the item in flight and its
      // progress, never the whole checklist (one paragraph, no extra blocks).
      case 'todo/write': {
        const next = todoSnapshot(event.data?.todos)
        if (next === undefined && st.todos === undefined) break
        st.todos = next
        this.scheduleFlush(session.id, st)
        break
      }
      case 'assistant/message': {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('')
          if (text.trim()) st.finalParts.push(text)
        }
        break
      }
      case 'turn/end': {
        void this.finalize(session.id, st, event.data?.reason)
        break
      }
    }
  }

  private scheduleFlush(sessionId: string, st: TurnState): void {
    if (st.async || st.mode !== 'aicard' || st.cardUnavailable || !this.deps.config.streaming.enabled) return
    if (st.flushTimer) return
    st.flushTimer = setTimeout(() => {
      st.flushTimer = undefined
      void this.flush(sessionId, st)
    }, this.deps.config.streaming.throttleMs)
  }

  private async flush(sessionId: string, st: TurnState): Promise<void> {
    if (st.flushing || st.cardUnavailable || !this.states.has(sessionId)) return
    st.flushing = true
    try {
      let card = st.cardPromise ? await st.cardPromise : null
      if (!card || !this.states.has(sessionId)) return
      const content = this.cardContent(st)
      if (!content.trim()) return
      // Over-length roll-over (Feishu streamMaxElementChars analog): settle the
      // full current card and continue on a fresh one below it.
      if (content.length > this.deps.config.streaming.maxCardChars) {
        st.needsRollover = true
      }
      if (st.needsRollover) {
        card = await this.rollOverNow(st, card)
        if (!card || !this.states.has(sessionId)) return
        this.scheduleFlush(sessionId, st)
        return
      } else if (content === st.lastFlushed) {
        return
      }
      await card.stream(content)
      st.lastFlushed = content
      st.settledOpenText = st.openText.length
    } catch (err) {
      this.deps.log(`stream flush error: ${err instanceof Error ? err.message : err}`)
      if (err instanceof CardCapabilityError) st.cardUnavailable = true
    } finally {
      st.flushing = false
    }
  }

  private async finalize(sessionId: string, st: TurnState, reason: any): Promise<void> {
    // Snapshot-and-delete first: turn/end and a late flush may race, and a
    // second finalize on the same state must be impossible.
    this.states.delete(sessionId)
    if (st.flushTimer) clearTimeout(st.flushTimer)

    const { config, outbound, emotion } = this.deps
    if (config.emotionFirstResponse) await emotion.recall(st.msg.msgId, st.msg.conversationId)
    // Release the queue lane no matter how rendering below fares.
    st.settle()

    const kind = reason?.kind
    const failure = reason?.failure ?? reason?.error
    const failureMessage = typeof failure === 'string' ? failure : failure?.message
    const failureCode =
      typeof failure === 'object' && failure !== null && failure.code !== undefined ? String(failure.code) : undefined
    const errText = kind === 'error' ? describeTurnError(failureMessage, failureCode) : ''
    if (errText) this.deps.log(`turn ended in error: ${failureMessage ?? failureCode ?? 'unknown'}`)
    // 'aborted' is the host's cancellation variant (TurnEndReasonMap) — the
    // user already got its confirmation elsewhere, settle without publishing.
    const interrupted = kind === 'aborted'

    const substance = st.finalParts.join('\n\n').trim()

    if (interrupted) {
      // Quiet settle: freeze the old card in place, never roll over or add
      // bubbles for a dead turn (a canceled task once spawned a ghost card
      // holding a single tool line). The folded header already says 任务已打断.
      for (const step of st.steps) if (step.state === 'running') step.state = 'stopped'
      const body = this.renderSettled(st, 'stopped', substance, '')
      const card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
      if (card) {
        try {
          await card.finish(body || '⏹️ 任务已打断')
          this.deps.log('card settled (interrupted)')
        } catch (err) {
          this.deps.log(`interrupted settle failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      return
    }

    const outcome = errText ? 'failed' : 'completed'
    let card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
    let content: string
    // A newer bubble sits below the live card. Roll over only for output that has
    // not been shown yet (and only if this card streamed something): otherwise a
    // pointer would be a lie and the next card would repeat the same answer.
    const unstreamed = st.openText.slice(st.settledOpenText).trim() !== ''
    if (card && st.needsRollover && st.lastFlushed !== '' && unstreamed) {
      card = await this.rollOverNow(st, card)
      content = this.renderSettled(st, outcome, '', errText)
    } else {
      st.needsRollover = false
      content = this.renderSettled(st, outcome, substance, errText)
    }
    if (card) {
      try {
        if (errText) await card.fail(content)
        else await card.finish(content)
        this.deps.log(`card settled (${content.length} chars)`)
        return
      } catch (err) {
        this.deps.log(`card settle failed, falling back to markdown: ${err instanceof Error ? err.message : err}`)
      }
    }
    // markdown / text / asyncMode / card-fallback all land here.
    if (st.mode === 'text' && !errText) await outbound.sendText(st.msg, content)
    else await outbound.sendMarkdown(st.msg, config.markdownTitle, content)
  }
}
