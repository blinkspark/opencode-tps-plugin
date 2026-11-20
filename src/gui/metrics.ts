// Pure metric math. No Solid, no DOM, no imports: this module can be replayed
// offline with `node --experimental-strip-types` to verify the numbers.

export const WINDOW_MS = 2_000
export const MIN_SPAN_MS = 350
export const MIN_AVG_SPAN_MS = 500
export const MIN_AVG_DELTAS = 3
export const TICK_MS = 200
export const DEFAULT_CHARS_PER_TOKEN = 4
export const RATIO_MIN = 0.5
export const RATIO_MAX = 12
export const LONG_WAIT_MS = 10_000
export const MIN_FALLBACK_MS = 250
/** A tool that reports no completion for this long stops adding run time. */
export const TOOL_RUN_CAP_MS = 30 * 60_000

export interface Sample {
  at: number
  chars: number
}

export interface StepEntry {
  id: string
  tokens: number
  genMs: number
  waitMs: number
  approx: boolean
  longWait: boolean
  /** Seeded from the transcript, which only has full-step timing. */
  fromHistory: boolean
  at: number
}

export interface Totals {
  tokens: number
  ms: number
  waitMs: number
  approxMs: number
  longWaitSteps: number
  steps: number
}

/** A half-open run interval. */
export interface Span {
  start: number
  end: number
}

/** A still-running interval: a model step or a tool execution. */
export interface OpenSpan {
  start: number
  /** Tool intervals are capped; a model step is not. */
  tool: boolean
}

export interface RunInfo {
  /** Closed intervals, sorted and disjoint. */
  spans: readonly Span[]
  /** Length of `spans`, kept incrementally so rendering stays O(1). */
  totalMs: number
  open: readonly OpenSpan[]
  /** How many tool intervals hit {@link TOOL_RUN_CAP_MS}. */
  capped: number
}

export interface StepTimingInput {
  startedAt: number
  /** First output of any kind (text, reasoning, or tool-call arguments). */
  firstOutputAt: number
  firstCountedAt: number
  lastDeltaAt: number
  lastActivityAt: number
  streamedAt: number
  countedDeltas: number
  ignoredReasoning: boolean
  end: number
}

export interface StepMeasurement {
  genMs: number
  waitMs: number
  approx: boolean
  longWait: boolean
  reliable: boolean
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 10) return String(Math.round(value))
  return value.toFixed(1)
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%"
  const percent = value * 100
  if (percent >= 99.5) return "100%"
  if (percent >= 9.95) return `${Math.round(percent)}%`
  return `${percent.toFixed(1)}%`
}

export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 1_000)}s`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 60_000) return formatSeconds(ms)

  const seconds = Math.round(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

/**
 * Inserts an interval into a sorted, disjoint list, merging every overlap.
 * Mutates `spans` and returns how many milliseconds were actually new, so the
 * caller can keep a running total and seeding the same message twice is a
 * no-op.
 */
export function insertSpan(spans: Span[], start: number, end: number): number {
  if (!(end > start)) return 0

  let low = 0
  let high = spans.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (spans[middle]!.end < start) low = middle + 1
    else high = middle
  }

  let mergedStart = start
  let mergedEnd = end
  let removed = 0
  let index = low

  while (index < spans.length && spans[index]!.start <= mergedEnd) {
    const current = spans[index]!
    if (current.start < mergedStart) mergedStart = current.start
    if (current.end > mergedEnd) mergedEnd = current.end
    removed += current.end - current.start
    index += 1
  }

  spans.splice(low, index - low, { start: mergedStart, end: mergedEnd })
  return mergedEnd - mergedStart - removed
}

/**
 * The session run time with the open intervals included. Open intervals start
 * after the closed ones in practice; any overlap with the last closed span is
 * ignored so a step that is currently being observed is not counted twice.
 */
export function runtimeWithOpen(run: RunInfo, now: number): number {
  if (run.open.length === 0) return run.totalMs

  let from = Number.POSITIVE_INFINITY
  let to = 0
  for (const span of run.open) {
    if (span.start < from) from = span.start
    const end = span.tool ? Math.min(now, span.start + TOOL_RUN_CAP_MS) : now
    if (end > to) to = end
  }

  const last = run.spans.length > 0 ? run.spans[run.spans.length - 1]!.end : 0
  return run.totalMs + Math.max(0, to - Math.max(from, last))
}

export function rateOf(tokens: number, ms: number): number {
  return tokens / (Math.max(1, ms) / 1_000)
}

export function liveRate(
  samples: readonly Sample[],
  firstCountedAt: number,
  ratio: number,
  now: number,
): number | undefined {
  if (firstCountedAt === 0) return undefined

  const from = Math.max(firstCountedAt, now - WINDOW_MS)
  let chars = 0
  let count = 0

  for (const sample of samples) {
    if (sample.at >= from) {
      chars += sample.chars
      count += 1
    }
  }

  // The window is empty during tool execution or a long pause. Hiding the
  // value is better than showing a misleading ~0 tok/s.
  if (count === 0) return undefined

  const span = Math.max(MIN_SPAN_MS, now - from) / 1_000
  return chars / ratio / span
}

/**
 * Splits a step into the generation window and the silent wait before the first
 * visible token. The wait (provider queueing, rate limits, hidden reasoning)
 * is deliberately kept out of `genMs` so it never dilutes the average speed.
 */
export function measureStep(input: StepTimingInput): StepMeasurement {
  const {
    startedAt,
    firstOutputAt,
    firstCountedAt,
    lastDeltaAt,
    lastActivityAt,
    streamedAt,
    countedDeltas,
    ignoredReasoning,
    end,
  } = input

  const timingStart = firstCountedAt > 0 ? firstCountedAt : firstOutputAt
  const observedEnd = Math.max(streamedAt, lastActivityAt, lastDeltaAt)
  const observedSpan = timingStart > 0 && observedEnd >= timingStart ? observedEnd - timingStart : 0
  const reliable =
    !ignoredReasoning && countedDeltas >= MIN_AVG_DELTAS && observedSpan >= MIN_AVG_SPAN_MS

  const waitMs = startedAt > 0 && firstOutputAt > 0 ? Math.max(0, firstOutputAt - startedAt) : 0
  const longWait = waitMs > LONG_WAIT_MS

  let genMs: number
  if (reliable) {
    const from = Math.max(startedAt, timingStart)
    genMs = Math.max(1, observedEnd - from)
  } else {
    // Prefer the visible-content window, never the request start. A provider
    // that flushes one big chunk would otherwise divide by a near-zero span,
    // so keep a floor; a step with no visible event at all falls back to the
    // full duration and is marked approximate.
    const from = timingStart > 0 ? timingStart : firstOutputAt > 0 ? firstOutputAt : startedAt
    const span = observedEnd > from ? observedEnd - from : 0
    genMs =
      from > 0 && span > 0
        ? Math.max(MIN_FALLBACK_MS, span)
        : Math.max(1, (streamedAt > 0 ? streamedAt : end) - startedAt)
  }

  return { genMs, waitMs, approx: !reliable, longWait, reliable }
}

export function totalsOf(entries: Iterable<StepEntry>): Totals {
  let tokens = 0
  let ms = 0
  let waitMs = 0
  let approxMs = 0
  let longWaitSteps = 0
  let steps = 0

  for (const step of entries) {
    tokens += step.tokens
    ms += step.genMs
    waitMs += step.waitMs
    if (step.approx) approxMs += step.genMs
    if (step.longWait) longWaitSteps += 1
    steps += 1
  }

  return { tokens, ms, waitMs, approxMs, longWaitSteps, steps }
}

export function latestStep(entries: Iterable<StepEntry>): StepEntry | undefined {
  let latest: StepEntry | undefined

  for (const step of entries) {
    if (!latest || step.at >= latest.at) latest = step
  }

  return latest
}
