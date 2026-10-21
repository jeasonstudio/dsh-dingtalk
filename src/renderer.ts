/**
 * Outbound orchestration: one active turn per session, rendered to the
 * conversation through the configured carrier — AI Card (streaming or
 * settle-once), markdown, plain text, or asyncMode (ack now, push later).
 * Consumes the `session/event` feed; the live streaming view is assembled
 * from `assistant/chunk` deltas plus ONE latest-activity line (thinking / the
 * tool call currently in flight), while the settled reply prefers the clean
 * aggregated `assistant/message` texts.
 */
import type { Config, ReplyMode } from './config.js'
import type { HostSession, HostSessionEvent } from './host.js'
import type { InboundMessage } from './stream.js'
import type { Emotion } from './emotion.js'
import type { ReplySink } from './reply-sink.js'
import { AICard, CardCapabilityError, type CardTarget } from './aicard.js'
import { cardTarget } from './targets.js'
import { describeTurnError } from './errors.js'
import { describeToolCall, renderActivityLine, type LiveActivity } from './activity.js'

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
  /** Latest visible activity; replaces rather than appends on every event. */
  activity?: LiveActivity
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
  /** Chars already settled onto earlier cards; the live card shows the remainder. */
  carryOffset: number
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
 * Render the live view to markdown: accumulated assistant text blocks in
 * arrival order, followed by at most ONE activity line describing the latest
 * thinking/tool state. The activity line is intentionally not a history: the
 * card is refreshed with full frames, so call N replaces call N-1.
 */
function renderLive(segments: Segment[], activity?: LiveActivity): string {
  const text = renderText(segments)
  if (!activity) return text
  const line = renderActivityLine(activity)
  return text ? `${text}\n\n${line}` : line
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
      finalParts: [],
      lastFlushed: '',
      flushing: false,
      needsRollover: false,
      cardUnavailable: false,
      carryOffset: 0,
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
          const last = st.live[st.live.length - 1]
          // Text after an activity line is a NEW visible block: the intervening
          // thinking/tool step must keep the paragraphs apart.
          if (last && st.activity === undefined) last.text += chunk.text
          else st.live.push({ kind: 'text', text: chunk.text })
          // Streaming text is the latest visible content on its own; the
          // transient activity line would only duplicate it.
          st.activity = undefined
          this.scheduleFlush(session.id, st)
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
          // Reasoning deltas are not copied into the card (too long, too noisy);
          // they only say that the agent is still thinking. Skip the line while
          // text is already streaming, so a late reasoning delta cannot split a
          // paragraph with a status line.
          if (!(st.activity === undefined && st.live.length > 0)) {
            st.activity = { kind: 'thinking' }
            this.scheduleFlush(session.id, st)
          }
        }
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        // One line only: a newer call replaces the previous activity instead of
        // appending another `⚙️ <tool> ✓` row to the card.
        st.activity = describeToolCall(name, event.data?.arguments, event.data?.callId)
        this.scheduleFlush(session.id, st)
        break
      }
      case 'tool/result': {
        const blocks = event.data?.message?.content
        const block = blocks?.[0]
        const callId = event.data?.callId ?? block?.toolCallId ?? event.data?.message?.source?.callId
        const current = st.activity
        // A result for an older (or uncorrelated) call must not overwrite the
        // newer call already running; only the latest activity is on screen.
        if (current?.kind !== 'tool') break
        if (current.callId !== undefined && callId !== current.callId) break
        const isError = Array.isArray(blocks) && blocks.some((item: any) => item?.isError === true)
        const failure = event.data?.error ?? (isError ? { code: 'tool_error' } : undefined)
        current.state = failure?.code === 'interrupted' ? 'stopped' : failure !== undefined ? 'error' : 'done'
        this.scheduleFlush(session.id, st)
        break
      }
      // PTC mode (`run_code`) reports nested calls on their own event pair; show
      // them through the same single line so a code-mode turn is not opaque.
      case 'tool/ptc-dispatch-start': {
        st.activity = describeToolCall(event.data?.name ?? 'tool', event.data?.arguments, event.data?.subCallId)
        this.scheduleFlush(session.id, st)
        break
      }
      case 'tool/ptc-dispatch': {
        const current = st.activity
        if (current?.kind !== 'tool') break
        const subCallId = event.data?.subCallId
        if (current.callId !== undefined && subCallId !== current.callId) break
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
      const full = renderLive(st.live, st.activity)
      const content = full.slice(st.carryOffset).trimStart()
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
        this.scheduleFlush(sessionId, st)
        return
      } else if (content === st.lastFlushed) {
        return
      }
      await card.stream(content)
      st.lastFlushed = content
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
    // The thinking placeholder is not a result: a reasoning-only turn must
    // still surface EMPTY_MODEL_RESPONSE, and a settled card must not freeze
    // a transient activity line.
    const finalActivity = st.activity?.kind === 'tool' ? st.activity : undefined
    const liveText = renderLive(st.live, finalActivity)

    if (interrupted) {
      // Quiet settle: freeze the old card in place, never roll over or add
      // bubbles for a dead turn (a canceled task once spawned a ghost card
      // holding a single tool line).
      const card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
      if (card) {
        // Only the current card's remainder: earlier cards already hold the
        // settled prefix from a roll-over.
        const tail = st.carryOffset > 0 ? liveText.slice(st.carryOffset).trimStart() : liveText
        try {
          await card.finish(`${tail ? `${tail}\n\n` : ''}⏹️ 任务已打断`)
          this.deps.log('card settled (interrupted)')
        } catch (err) {
          this.deps.log(`interrupted settle failed: ${err instanceof Error ? err.message : err}`)
        }
      }
      return
    }

    // After earlier roll-overs the settled cards already hold the prefix；
    // the final card carries the remainder (clean substance replaces the live
    // view only when no roll-over consumed part of it).
    let text = st.carryOffset > 0 ? liveText.slice(st.carryOffset).trimStart() : substance || liveText
    if (st.carryOffset > 0 && !text.trim()) text = substance ? '（完整内容见上方卡片）' : ''
    if (errText) text = text ? `${text}\n\n${errText}` : errText
    if (!text.trim()) text = EMPTY_MODEL_RESPONSE

    let card = !st.cardUnavailable && st.cardPromise ? await st.cardPromise : null
    if (card && st.needsRollover && (substance || errText)) {
      // Newer bubbles sit below the old card: settle it with a pointer and
      // land the final answer on a fresh card at the bottom. Tool-lines-only
      // output is not worth a fresh card.
      card = await this.rollover(st, card, renderText(st.live).slice(st.carryOffset))
    }
    if (card) {
      try {
        if (errText) await card.fail(text)
        else await card.finish(text)
        this.deps.log(`card settled (${text.length} chars)`)
        return
      } catch (err) {
        this.deps.log(`card settle failed, falling back to markdown: ${err instanceof Error ? err.message : err}`)
      }
    }
    // markdown / text / asyncMode / card-fallback all land here.
    if (st.mode === 'text' && !errText) await outbound.sendText(st.msg, text)
    else await outbound.sendMarkdown(st.msg, config.markdownTitle, text)
  }
}
