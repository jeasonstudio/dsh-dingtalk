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
} from './activity.js'

const EMPTY_MODEL_RESPONSE =
  '⚠️ **模型本次未产出正文**\n> 可能是输出额度被推理占满，请调大 `max_tokens` 或更换模型后重试。'

interface Segment {
  kind: 'text'
  text: string
}

interface TurnState {
  msg: InboundMessage
  mode: ReplyMode
  async: boolean
  /** Visible assistant text, in arrival order. */
  live: Segment[]
  /**
   * Work steps of this turn in arrival order. The last one may still be running;
   * the process line renders the current step plus a short breadcrumb of the
   * finished ones, so the card keeps a little history without spending a block
   * (and a paragraph gap) per step.
   */
  steps: ToolActivity[]
  /** Start of the reasoning stretch in flight (ms); unset when not thinking. */
  thinkingStartedAt?: number
  /** Accumulated finished reasoning time (ms). */
  thinkingMs: number
  /** Latest `todo/write` snapshot of this turn, when a task is in flight. */
  todos?: TodoSnapshot
  /** A step happened since the last text delta, so the next delta opens a block. */
  segmentClosed: boolean
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
  /** Chars already settled onto earlier cards; the live card shows the remainder. */
  carryOffset: number
  /**
   * Chars of `renderText(live)` already written to the CURRENT card. A turn
   * that ends right after an interleaved bubble must not copy text the card
   * below it already shows — `carryOffset` alone cannot tell "settled onto an
   * earlier card" from "streamed onto this one".
   */
  streamedTextLength: number
  /** Resolves when the turn settles; the queue serializes on this. */
  settle: () => void
}

/**
 * Render the accumulated assistant text blocks (no transient activity).
 * Roll-over offsets compare against THIS length: the activity line mutates in
 * place, so only the text prefix is stable enough to keep across cards.
 */
function renderText(segments: Segment[]): string {
  return segments
    .map((seg) => seg.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Compose the card payload: the process line first, then the answer text.
 *
 * Both are plain paragraphs separated by one blank line. The process line is
 * deliberately NOT a blockquote and never spans several blocks: DingTalk renders
 * every block with a full paragraph gap, and merges soft line breaks inside a
 * quote, so a multi-row work log cost half a screen. One compact paragraph keeps
 * the same information at normal paragraph spacing.
 */
function composeContent(processLine: string, text: string): string {
  if (!processLine) return text
  return text ? `${processLine}\n\n${text}` : processLine
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
      live: [],
      steps: [],
      thinkingMs: 0,
      segmentClosed: false,
      startedAt: Date.now(),
      finalParts: [],
      lastFlushed: '',
      flushing: false,
      needsRollover: false,
      cardUnavailable: false,
      carryOffset: 0,
      streamedTextLength: 0,
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

  /** Close the reasoning stretch in flight and bank its duration. */
  private closeThinking(st: TurnState): void {
    if (st.thinkingStartedAt === undefined) return
    st.thinkingMs += Date.now() - st.thinkingStartedAt
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

  private snapshot(st: TurnState): ProcessSnapshot {
    return {
      steps: st.steps,
      thinkingMs: st.thinkingMs,
      thinking: st.thinkingStartedAt !== undefined,
      elapsedMs: Date.now() - st.startedAt,
    }
  }

  /** Settle the old card with a pointer note and continue on a fresh one. */
  private async rollover(st: TurnState, card: AICard, content: string): Promise<AICard | null> {
    st.needsRollover = false
    try {
      await card.finish(`${content || '…'}\n\n> ⤵️ 输出继续，见下方新卡片`)
      this.deps.log('card rolled over')
    } catch (err) {
      this.deps.log(`rollover finish failed: ${err instanceof Error ? err.message : err}`)
    }
    st.lastFlushed = ''
    st.cardPromise = this.deps.createCard(cardTarget(st.msg))
    return st.cardPromise
  }

  onSessionEvent(session: HostSession, event: HostSessionEvent): void {
    const st = this.states.get(session.id)
    if (!st) return
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          this.closeThinking(st)
          const last = st.live[st.live.length - 1]
          // Text after a step is a NEW visible block: the intervening thinking or
          // tool run must keep the paragraphs apart.
          if (last && !st.segmentClosed) last.text += chunk.text
          else st.live.push({ kind: 'text', text: chunk.text })
          st.segmentClosed = false
          this.scheduleFlush(session.id, st)
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
          // Reasoning deltas are not copied into the card (too long, too noisy);
          // they only drive the 正在分析请求 row and its settled duration. Skip it
          // while text is streaming inside one block, so a late delta cannot
          // reopen a thinking row in the middle of a paragraph.
          if (st.segmentClosed || st.live.length === 0) {
            st.thinkingStartedAt ??= Date.now()
            this.scheduleFlush(session.id, st)
          }
        }
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        // Append, do not replace: the process line keeps a short breadcrumb so
        // the card says what was already done, not only what is running now.
        st.steps.push(describeToolCall(name, event.data?.arguments, event.data?.callId))
        this.closeThinking(st)
        st.segmentClosed = true
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
      // PTC mode (`run_code`) reports nested calls on their own event pair; show
      // them through the same single line so a code-mode turn is not opaque.
      case 'tool/ptc-dispatch-start': {
        st.steps.push(describeToolCall(event.data?.name ?? 'tool', event.data?.arguments, event.data?.subCallId))
        this.closeThinking(st)
        st.segmentClosed = true
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
      const leadParts = [renderTodoLine(st.todos), renderProcessLine(this.snapshot(st))]
      // The lead lines are rebuilt every frame and live ABOVE the answer, so only
      // the text carries a roll-over offset; it is sliced in text coordinates.
      const lead = leadParts.filter(Boolean).join('\n\n')
      const content = composeContent(lead, renderText(st.live).slice(st.carryOffset)).trim()
      if (!content.trim()) return
      // Over-length roll-over (Feishu streamMaxElementChars analog): settle the
      // full current card and continue the remainder on a fresh one.
      if (content.length > this.deps.config.streaming.maxCardChars) {
        st.needsRollover = true
      }
      if (st.needsRollover) {
        // Settle the old card with the stable text tail ONLY: the activity line
        // is transient and belongs on the live card. Snapshot the offset
        // BEFORE the rollover RPCs — chunks arriving meanwhile belong to the
        // NEW card and must not be swallowed by the advance.
        const text = renderText(st.live)
        const settledText = text.slice(st.carryOffset)
        const nextOffset = text.length
        card = await this.rollover(st, card, settledText)
        if (!card || !this.states.has(sessionId)) return
        st.carryOffset = nextOffset
        st.streamedTextLength = nextOffset
        this.scheduleFlush(sessionId, st)
        return
      } else if (content === st.lastFlushed) {
        return
      }
      // Snapshot before the RPC: chunks arriving during it belong to the next
      // frame, so they must not be counted as already on this card.
      const textLength = renderText(st.live).length
      await card.stream(content)
      st.lastFlushed = content
      st.streamedTextLength = textLength
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
    // Reasoning only says the agent is alive; it is not a result. The settled
    // card therefore prefers the clean `assistant/message` text, and a
    // reasoning-only turn still surfaces EMPTY_MODEL_RESPONSE.
    this.closeThinking(st)
    const liveText = renderText(st.live)

    if (interrupted) {
      // Quiet settle: freeze the old card in place, never roll over or add
      // bubbles for a dead turn (a canceled task once spawned a ghost card
      // holding a single tool line). The folded header already says 任务已打断.
      for (const step of st.steps) if (step.state === 'running') step.state = 'stopped'
      const stopped = renderProcessSettled(this.snapshot(st), 'stopped')
      const card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
      if (card) {
        // Only the current card's remainder: earlier cards already hold the
        // settled prefix from a roll-over.
        const tail = st.carryOffset > 0 ? liveText.slice(st.carryOffset).trimStart() : liveText
        // The folded header already carries 任务已打断; only a turn with nothing
        // to fold needs the bare note.
        const body = composeContent(stopped, tail)
        try {
          await card.finish(body || '⏹️ 任务已打断')
          this.deps.log('card settled (interrupted)')
        } catch (err) {
          this.deps.log(`interrupted settle failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      return
    }

    // 简洁 mode folds the work steps once the answer is done: one header line
    // survives above the answer, instead of the live breadcrumb.
    const settledBlock = renderProcessSettled(this.snapshot(st), errText ? 'failed' : 'completed')
    // After earlier roll-overs the settled cards already hold the prefix；
    // the final card carries the remainder (clean substance replaces the live
    // view only when no roll-over consumed part of it).
    let text = st.carryOffset > 0 ? liveText.slice(st.carryOffset).trimStart() : substance || liveText
    if (errText) text = text ? `${text}\n\n${errText}` : errText
    // A card with only the folded header is fine when the answer itself was
    // already settled on an earlier card; a turn that produced no text at all
    // still gets the empty-response warning.
    if (!text.trim() && !substance) text = EMPTY_MODEL_RESPONSE

    let card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
    if (card && st.needsRollover && (substance || errText)) {
      // Newer bubbles sit below the old card. Roll over only while output is
      // still arriving: the old card keeps what it already streamed (plus the
      // pointer) and the fresh card carries the remainder. If nothing is
      // unstreamed, a pointer would be a lie and the next card would repeat the
      // whole answer — settle in place instead. Tool-lines-only output is not
      // worth a fresh card either.
      const settledText = renderText(st.live)
      const streamed = Math.max(st.carryOffset, st.streamedTextLength)
      if (streamed > st.carryOffset && settledText.slice(streamed).trim()) {
        const tail = liveText.slice(st.carryOffset, streamed)
        card = await this.rollover(st, card, tail)
        st.carryOffset = streamed
        st.streamedTextLength = streamed
        text = liveText.slice(streamed).trimStart()
        if (errText) text = text ? `${text}\n\n${errText}` : errText
      } else {
        st.needsRollover = false
      }
    }
    const content = composeContent(settledBlock, text)
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
