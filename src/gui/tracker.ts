import { createRoot, createSignal, getOwner, runWithOwner, type Owner } from "solid-js"
import type { MountedSession } from "@opencode/plugin/gui"
import {
  DEFAULT_CHARS_PER_TOKEN,
  LONG_WAIT_MS,
  RATIO_MAX,
  RATIO_MIN,
  TOOL_RUN_CAP_MS,
  WINDOW_MS,
  clamp,
  insertSpan,
  measureStep,
  type OpenSpan,
  type RunInfo,
  type Sample,
  type Span,
  type StepEntry,
} from "./metrics"

type Data = MountedSession["server"]["data"]

export interface TtftInfo {
  ms: number
  approx: boolean
  longWait: boolean
  /** The step produced no text/reasoning, so this value is the previous one. */
  stale: boolean
}

export interface LiveState {
  startedAt: number
  /** First output of any kind: drives the generation window and averages. */
  firstOutputAt: number
  /** First text/reasoning output only: drives TTFT. */
  firstTextAt: number
  firstCountedAt: number
  lastDeltaAt: number
  lastActivityAt: number
  streamedAt: number
  sawReasoningOutput: boolean
  countedDeltas: number
  stepChars: number
  toolChars: number
  samples: Sample[]
  ratio: number
}

export interface TtftAverage {
  totalMs: number
  steps: number
  longWaitSteps: number
}

export interface Snapshot {
  running: boolean
  live: LiveState
  entries: Map<string, StepEntry>
  ttft: TtftInfo | undefined
  /** Only steps observed live: the transcript has no first-token timestamp. */
  ttftAverage: TtftAverage
  /** Wall-clock time the session spent generating or running tools. */
  run: RunInfo
}

interface RuntimeState {
  spans: Span[]
  totalMs: number
  model: Span[]
  modelMs: number
  tool: Span[]
  toolMs: number
  open: Map<string, OpenSpan>
  capped: number
  /** Keys of transcript intervals already merged, so re-reads stay cheap. */
  seeded: Set<string>
}

interface SessionState {
  running: boolean
  live: LiveState
  entries: Map<string, StepEntry>
  ttft: TtftInfo | undefined
  ttftAverage: TtftAverage
  touched: number
  runtime: RuntimeState
}

type DeltaKind = "text" | "reasoning"

const MAX_SESSIONS = 32

const sessions = new Map<string, SessionState>()
const attached = new WeakSet<Data>()
let configured = true

// A private, never-disposed owner keeps the event subscriptions alive for the
// whole plugin lifetime. Header badges come and go as tabs are cached, so their
// owner is not a safe place for the single global subscription.
let owner: Owner | null = null
let disposeRoot: () => void = () => {}
let readVersion: () => number = () => 0
let bump: () => void = () => {}

createRoot((dispose) => {
  disposeRoot = dispose
  owner = getOwner()
  const [version, setVersion] = createSignal(0)
  readVersion = version
  bump = () => setVersion((value) => value + 1)
})

/** Subscribe to version changes so a header re-renders after any event. */
export function version(): number {
  return readVersion()
}

/** Withdraw the global subscriptions when the plugin goes away (hot reload). */
export function dispose() {
  owner = null
  disposeRoot()
}

export function key(serverID: string, sessionID: string): string {
  return `${serverID}:${sessionID}`
}

function freshLive(ratio = DEFAULT_CHARS_PER_TOKEN): LiveState {
  return {
    startedAt: 0,
    firstOutputAt: 0,
    firstTextAt: 0,
    firstCountedAt: 0,
    lastDeltaAt: 0,
    lastActivityAt: 0,
    streamedAt: 0,
    sawReasoningOutput: false,
    countedDeltas: 0,
    stepChars: 0,
    toolChars: 0,
    samples: [],
    ratio,
  }
}

const emptyEntries = new Map<string, StepEntry>()
const EMPTY_RUN: RunInfo = {
  spans: [],
  totalMs: 0,
  modelSpans: [],
  modelMs: 0,
  toolSpans: [],
  toolMs: 0,
  open: [],
  capped: 0,
}
const EMPTY: Snapshot = {
  running: false,
  live: freshLive(),
  entries: emptyEntries,
  ttft: undefined,
  ttftAverage: { totalMs: 0, steps: 0, longWaitSteps: 0 },
  run: EMPTY_RUN,
}

function ensure(id: string): SessionState {
  let state = sessions.get(id)

  if (!state) {
    state = {
      entries: new Map(),
      ttft: undefined,
      ttftAverage: { totalMs: 0, steps: 0, longWaitSteps: 0 },
      live: freshLive(),
      running: false,
      touched: Date.now(),
      runtime: {
        spans: [],
        totalMs: 0,
        model: [],
        modelMs: 0,
        tool: [],
        toolMs: 0,
        open: new Map(),
        capped: 0,
        seeded: new Set(),
      },
    }
    sessions.set(id, state)

    if (sessions.size > MAX_SESSIONS) {
      let oldest: string | undefined
      let oldestTouch = Infinity
      for (const [candidate, value] of sessions) {
        if (candidate !== id && value.touched < oldestTouch) {
          oldestTouch = value.touched
          oldest = candidate
        }
      }
      if (oldest !== undefined) sessions.delete(oldest)
    }
  }

  state.touched = Date.now()
  return state
}

function notify(state: SessionState) {
  state.touched = Date.now()
  bump()
}

/**
 * An observed step always wins over a transcript-seeded one (which only has
 * full-step timing). Among observed steps, a precise delta-timed measurement
 * replaces an approximate one, never the other way round.
 */
function mergeStep(state: SessionState, step: StepEntry): boolean {
  const previous = state.entries.get(step.id)

  if (previous) {
    if (step.fromHistory) return false
    if (!previous.approx) return false
    if (!previous.fromHistory && step.approx) return false
  }

  state.entries.set(step.id, step)
  return true
}

export function configure(countReasoning: boolean) {
  if (configured === countReasoning) return
  configured = countReasoning
  sessions.clear()
  bump()
}

export function snapshot(serverID: string, sessionID: string): Snapshot {
  const state = sessions.get(key(serverID, sessionID))
  if (!state) return EMPTY

  // A fresh object so a memo reading `version()` always propagates.
  return {
    running: state.running,
    live: state.live,
    entries: state.entries,
    ttft: state.ttft,
    ttftAverage: state.ttftAverage,
    run: {
      spans: state.runtime.spans,
      totalMs: state.runtime.totalMs,
      modelSpans: state.runtime.model,
      modelMs: state.runtime.modelMs,
      toolSpans: state.runtime.tool,
      toolMs: state.runtime.toolMs,
      open: Array.from(state.runtime.open.values()),
      capped: state.runtime.capped,
    },
  }
}

/** Seed a step from the loaded transcript. Full-step timing is all it has. */
export function seedStep(
  serverID: string,
  sessionID: string,
  id: string,
  tokens: number,
  created: number,
  end: number,
) {
  if (tokens <= 0) return

  const state = ensure(key(serverID, sessionID))
  const changed = mergeStep(state, {
    id,
    tokens,
    genMs: Math.max(1, end - created),
    waitMs: 0,
    approx: true,
    longWait: false,
    fromHistory: true,
    at: end,
  })

  if (changed) notify(state)
}

function markFirstOutput(live: LiveState, time: number) {
  if (live.firstOutputAt > 0) return
  live.firstOutputAt = time
}

function markFirstText(live: LiveState, time: number) {
  markFirstOutput(live, time)
  if (live.firstTextAt > 0) return
  live.firstTextAt = time
}

function openRun(state: SessionState, key: string, start: number, tool: boolean) {
  if (!(start > 0)) return

  const existing = state.runtime.open.get(key)
  if (existing) {
    if (start < existing.start) existing.start = start
    return
  }

  state.runtime.open.set(key, { start, tool })
}

function closeRunSpan(state: SessionState, span: OpenSpan, end: number) {
  if (!(end > span.start)) return

  let finish = end
  const capped = span.tool && finish - span.start > TOOL_RUN_CAP_MS
  if (capped) finish = span.start + TOOL_RUN_CAP_MS

  state.runtime.totalMs += insertSpan(state.runtime.spans, span.start, finish)

  const track = span.tool ? state.runtime.tool : state.runtime.model
  const trackAdded = insertSpan(track, span.start, finish)
  if (span.tool) state.runtime.toolMs += trackAdded
  else state.runtime.modelMs += trackAdded

  if (capped && trackAdded > 0) state.runtime.capped += 1
}

function closeRun(state: SessionState, key: string, end: number) {
  const span = state.runtime.open.get(key)
  if (!span) return

  state.runtime.open.delete(key)
  closeRunSpan(state, span, end)
}

function closeAllRuns(state: SessionState, end: number) {
  for (const [key, span] of Array.from(state.runtime.open)) {
    state.runtime.open.delete(key)
    closeRunSpan(state, span, end)
  }
}

/**
 * Merge a step or tool interval from the loaded transcript. Keys include the
 * completion timestamp, and `insertSpan` is idempotent, so re-reading the
 * same message cannot double count.
 */
export function seedRun(
  serverID: string,
  sessionID: string,
  seedKey: string,
  start: number,
  end: number,
  tool: boolean,
) {
  if (!(start > 0) || !(end > start)) return

  const state = ensure(key(serverID, sessionID))
  if (state.runtime.seeded.has(seedKey)) return
  state.runtime.seeded.add(seedKey)

  let finish = end
  const capped = tool && finish - start > TOOL_RUN_CAP_MS
  if (capped) finish = start + TOOL_RUN_CAP_MS

  state.runtime.totalMs += insertSpan(state.runtime.spans, start, finish)

  const track = tool ? state.runtime.tool : state.runtime.model
  const trackAdded = insertSpan(track, start, finish)
  if (tool) state.runtime.toolMs += trackAdded
  else state.runtime.modelMs += trackAdded

  if (trackAdded <= 0) return
  if (capped) state.runtime.capped += 1
  notify(state)
}

function begin(serverID: string, sessionID: string, started: number) {
  const state = ensure(key(serverID, sessionID))
  const start = started > 0 ? started : Date.now()

  // A retry reuses the step slot; close a step that never reported an end
  // before starting the new attempt.
  closeRun(state, "step", start)
  state.live = freshLive(state.live.ratio)
  state.live.startedAt = start
  state.running = true
  openRun(state, "step", start, false)
  notify(state)
}

function push(
  serverID: string,
  sessionID: string,
  delta: string,
  at: number,
  kind: DeltaKind,
) {
  if (delta.length === 0) return

  const state = ensure(key(serverID, sessionID))
  const live = state.live
  const time = at > 0 ? at : Date.now()

  // TTFT only counts text/reasoning, so record it before the countReasoning
  // gate. Reasoning hidden from TPS still counts as the first text token.
  markFirstText(live, time)

  if (kind === "reasoning") {
    live.sawReasoningOutput = true
    // TTFT was recorded above; still publish that change even though the
    // reasoning delta itself is excluded from the TPS counters.
    if (!configured) {
      notify(state)
      return
    }
  }

  if (live.firstCountedAt === 0) live.firstCountedAt = time
  live.lastDeltaAt = time
  live.lastActivityAt = time
  live.countedDeltas += 1
  live.stepChars += delta.length
  live.samples.push({ at: time, chars: delta.length })

  const cutoff = time - WINDOW_MS
  while (live.samples.length > 0 && live.samples[0]!.at < cutoff) live.samples.shift()

  state.running = true
  notify(state)
}

/** Tool-call arguments are model output, so they belong to the step window. */
function toolInputStart(serverID: string, sessionID: string, at: number) {
  const state = ensure(key(serverID, sessionID))
  markFirstOutput(state.live, at > 0 ? at : Date.now())
  notify(state)
}

function toolInputEnd(serverID: string, sessionID: string, text: string, at: number) {
  const state = ensure(key(serverID, sessionID))
  const time = at > 0 ? at : Date.now()
  markFirstOutput(state.live, time)
  state.live.lastActivityAt = Math.max(state.live.lastActivityAt, time)
  state.live.toolChars += text.length
  notify(state)
}

function toolStart(serverID: string, sessionID: string, id: string, at: number) {
  const state = ensure(key(serverID, sessionID))
  const time = at > 0 ? at : Date.now()
  markFirstOutput(state.live, time)
  // Tool execution is part of the session's run time. `session.tool.called`
  // fires after any permission prompt, so waiting for the user is excluded.
  openRun(state, `tool:${id}`, time, true)
  notify(state)
}

function toolEnd(serverID: string, sessionID: string, id: string, at: number) {
  const state = ensure(key(serverID, sessionID))
  const time = at > 0 ? at : Date.now()
  state.live.lastActivityAt = Math.max(state.live.lastActivityAt, time)
  closeRun(state, `tool:${id}`, time)
  notify(state)
}

function streamed(serverID: string, sessionID: string, at: number) {
  const state = ensure(key(serverID, sessionID))
  const time = at > 0 ? at : Date.now()
  state.live.streamedAt = Math.max(state.live.streamedAt, time)
  state.live.lastActivityAt = Math.max(state.live.lastActivityAt, time)
  notify(state)
}

function finish(
  serverID: string,
  sessionID: string,
  assistantMessageID: string,
  tokens: { output: number; reasoning: number },
  at: number,
  failed: boolean,
) {
  const state = ensure(key(serverID, sessionID))
  const live = state.live
  const produced = Math.max(0, tokens.output + (configured ? tokens.reasoning : 0))
  const end = at > 0 ? at : Date.now()
  // The request window ends with the step, whether it succeeded or failed.
  closeRun(state, "step", end)
  // A step whose `step.started` was missed has no usable baseline. Leave it to
  // the transcript seed instead of dividing by epoch-sized nonsense.
  const valid = live.startedAt > 0 && live.startedAt <= end

  let ratio = live.ratio

  if (valid) {
    // Reasoning tokens can be hidden: the provider reports them but streams no
    // reasoning output. Measuring from the first visible delta would then
    // inflate the rate, so the whole step is marked approximate.
    const hiddenReasoning = tokens.reasoning > 0 && !live.sawReasoningOutput
    const ignoredReasoning = configured && hiddenReasoning

    const measured = measureStep({
      startedAt: live.startedAt,
      firstOutputAt: live.firstOutputAt,
      firstCountedAt: live.firstCountedAt,
      lastDeltaAt: live.lastDeltaAt,
      lastActivityAt: live.lastActivityAt,
      streamedAt: live.streamedAt,
      countedDeltas: live.countedDeltas,
      ignoredReasoning,
      end,
    })

    if (produced > 0) {
      // Failed attempts never enter the session average: their partial tokens
      // describe a step the user never received. The successful retry that
      // follows records its own numbers.
      if (!failed) {
        mergeStep(state, {
          id: assistantMessageID,
          tokens: produced,
          genMs: measured.genMs,
          waitMs: measured.waitMs,
          approx: measured.approx,
          longWait: measured.longWait,
          fromHistory: false,
          at: end,
        })
      }

      // Providers and languages differ a lot, so learn an adaptive
      // chars/token ratio from the previous completed step. The ratio is just
      // calibration, so partial output from a failed attempt still helps.
      const chars = live.stepChars + live.toolChars
      if (chars >= 32 && !ignoredReasoning) {
        const sample = clamp(chars / produced, RATIO_MIN, RATIO_MAX)
        ratio = clamp(live.ratio * 0.5 + sample * 0.5, RATIO_MIN, RATIO_MAX)
      }
    }

    // A failed attempt is not a completed step: it never updates the
    // previous-step TTFT and never enters the average. The retry's
    // `session.step.started` resets the live state, and only the successful
    // attempt records the first-token latency.
    if (!failed) {
      if (live.firstTextAt > 0) {
        const ms = Math.max(0, live.firstTextAt - live.startedAt)
        const longWait = ms > LONG_WAIT_MS
        state.ttft = {
          ms,
          approx: hiddenReasoning,
          longWait,
          stale: false,
        }
        // Tool-only steps never reach this branch, so they stay out of the
        // average as well.
        state.ttftAverage.totalMs += ms
        state.ttftAverage.steps += 1
        if (longWait) state.ttftAverage.longWaitSteps += 1
      } else if (state.ttft) {
        // Successful tool-only step: keep the last text-token latency but mark
        // it so the tooltip does not pretend it belongs to this step.
        state.ttft = { ...state.ttft, stale: true }
      }
    }
  }

  state.live = freshLive(ratio)
  state.running = false
  notify(state)
}

function stop(serverID: string, sessionID: string, at?: number) {
  const state = sessions.get(key(serverID, sessionID))
  if (!state) return

  // Execution-level stops close anything that is still open: a step that
  // never reported an end, or a tool whose completion was lost.
  closeAllRuns(state, at && at > 0 ? at : Date.now())
  state.live = freshLive(state.live.ratio)
  state.running = false
  // Keep `ttft`: it describes the last completed step, and it must survive
  // routing changes so the idle badge keeps its value.
  notify(state)
}

/**
 * Attach one subscription per server data object. Handlers route by
 * `event.data.sessionID` instead of the currently displayed session, so steps
 * running in a background tab are still recorded.
 *
 * `session.retry.scheduled` is intentionally ignored: `data.at` is the future
 * `nextRetryAt`, and a real `session.step.started` follows each retry. Using it
 * as the step start produced `TTFT 0s…` during backoff.
 */
export function attach(data: Data, serverID: string) {
  if (attached.has(data)) return
  attached.add(data)

  const register = () => {
    data.on("session.step.started", (event) => {
      begin(serverID, event.data.sessionID, event.data.started)
    })
    data.on("session.text.started", (event) => {
      const state = ensure(key(serverID, event.data.sessionID))
      markFirstText(state.live, event.created)
      notify(state)
    })
    data.on("session.reasoning.started", (event) => {
      const state = ensure(key(serverID, event.data.sessionID))
      markFirstText(state.live, event.created)
      state.live.sawReasoningOutput = true
      notify(state)
    })
    data.on("session.text.delta", (event) => {
      push(serverID, event.data.sessionID, event.data.delta, event.created, "text")
    })
    data.on("session.reasoning.delta", (event) => {
      push(serverID, event.data.sessionID, event.data.delta, event.created, "reasoning")
    })
    data.on("session.tool.input.started", (event) => {
      toolInputStart(serverID, event.data.sessionID, event.created)
    })
    data.on("session.tool.input.ended", (event) => {
      toolInputEnd(serverID, event.data.sessionID, event.data.text, event.created)
    })
    data.on("session.tool.called", (event) => {
      toolStart(serverID, event.data.sessionID, event.data.id, event.created)
    })
    data.on("session.tool.success", (event) => {
      toolEnd(serverID, event.data.sessionID, event.data.id, event.created)
    })
    data.on("session.tool.failed", (event) => {
      toolEnd(serverID, event.data.sessionID, event.data.id, event.created)
    })
    data.on("session.step.streamed", (event) => {
      streamed(serverID, event.data.sessionID, event.created)
    })
    data.on("session.step.ended", (event) => {
      finish(serverID, event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.created, false)
    })
    // Partial tokens from a failed attempt still count for the session
    // average; the `failed` flag keeps the attempt out of TTFT. `tokens` can be
    // absent when the failure happened before any usage was reported.
    data.on("session.step.failed", (event) => {
      if (event.data.tokens) {
        finish(serverID, event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.created, true)
      } else {
        stop(serverID, event.data.sessionID, event.created)
      }
    })
    data.on("session.idle", (event) => {
      stop(serverID, event.data.sessionID, event.created)
    })
    data.on("session.execution.succeeded", (event) => {
      stop(serverID, event.data.sessionID, event.created)
    })
    data.on("session.execution.failed", (event) => {
      stop(serverID, event.data.sessionID, event.created)
    })
    data.on("session.execution.interrupted", (event) => {
      stop(serverID, event.data.sessionID, event.created)
    })
  }

  if (owner) runWithOwner(owner, register)
  else register()
}
