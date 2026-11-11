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

export interface StepTimingInput {
  startedAt: number
  firstTokenAt: number
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
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
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
    firstTokenAt,
    firstCountedAt,
    lastDeltaAt,
    lastActivityAt,
    streamedAt,
    countedDeltas,
    ignoredReasoning,
    end,
  } = input

  const timingStart = firstCountedAt > 0 ? firstCountedAt : firstTokenAt
  const observedEnd = Math.max(streamedAt, lastActivityAt, lastDeltaAt)
  const observedSpan = timingStart > 0 && observedEnd >= timingStart ? observedEnd - timingStart : 0
  const reliable =
    !ignoredReasoning && countedDeltas >= MIN_AVG_DELTAS && observedSpan >= MIN_AVG_SPAN_MS

  const waitMs = startedAt > 0 && firstTokenAt > 0 ? Math.max(0, firstTokenAt - startedAt) : 0
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
    const from = timingStart > 0 ? timingStart : firstTokenAt > 0 ? firstTokenAt : startedAt
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
