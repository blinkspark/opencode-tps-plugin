import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"

export interface TpsBadgeProps {
  session: MountedSession
  compact: boolean
  countReasoning: boolean
}

type Last = {
  tps: number
  tokens: number
  ms: number
  approx: boolean
}

type Ttft = {
  ms: number
  approx: boolean
}

type Metric = {
  label: string
  title: string
}

type Sample = {
  at: number
  chars: number
}

type DeltaKind = "text" | "reasoning"

const WINDOW_MS = 2_000
const MIN_SPAN_MS = 350
const MIN_AVG_SPAN_MS = 500
const MIN_AVG_DELTAS = 3
const TICK_MS = 200
const DEFAULT_CHARS_PER_TOKEN = 4
const RATIO_MIN = 0.5
const RATIO_MAX = 12

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 10) return String(Math.round(value))
  return value.toFixed(1)
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%"
  const percent = value * 100
  if (percent >= 99.5) return "100%"
  if (percent >= 9.95) return `${Math.round(percent)}%`
  return `${percent.toFixed(1)}%`
}

function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 1_000)}s`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function TpsBadge(props: TpsBadgeProps) {
  const [running, setRunning] = createSignal(false)
  const [last, setLast] = createSignal<Last>()
  const [lastTtft, setLastTtft] = createSignal<Ttft>()
  const [liveTtft, setLiveTtft] = createSignal<number>()
  const [tick, setTick] = createSignal(0)

  // Characters per token, learned from the previous completed step. Providers and
  // languages differ a lot, so an adaptive ratio beats a fixed one.
  let ratio = DEFAULT_CHARS_PER_TOKEN
  let startedAt = 0
  let firstTokenAt = 0
  let firstCountedAt = 0
  let lastDeltaAt = 0
  let lastActivityAt = 0
  let streamedAt = 0
  let sawReasoningDelta = false
  let countedDeltas = 0
  let stepChars = 0
  let toolChars = 0
  let samples: Sample[] = []

  const reset = () => {
    startedAt = 0
    firstTokenAt = 0
    firstCountedAt = 0
    lastDeltaAt = 0
    lastActivityAt = 0
    streamedAt = 0
    sawReasoningDelta = false
    countedDeltas = 0
    stepChars = 0
    toolChars = 0
    samples = []
  }

  const markFirstToken = (time: number) => {
    if (firstTokenAt > 0) return
    firstTokenAt = time
    if (startedAt > 0) setLiveTtft(Math.max(0, time - startedAt))
  }

  const push = (sessionID: string, delta: string, at: number, kind: DeltaKind) => {
    if (sessionID !== props.session.id || delta.length === 0) return

    const time = at > 0 ? at : Date.now()

    // TTFT is about the first token of any kind, so record it before the
    // countReasoning gate. This also covers reasoning deltas hidden from TPS.
    markFirstToken(time)

    if (kind === "reasoning") {
      sawReasoningDelta = true
      if (!props.countReasoning) return
    }

    if (firstCountedAt === 0) firstCountedAt = time
    lastDeltaAt = time
    lastActivityAt = time
    countedDeltas += 1
    stepChars += delta.length
    samples.push({ at: time, chars: delta.length })

    const cutoff = time - WINDOW_MS
    while (samples.length > 0 && samples[0]!.at < cutoff) samples.shift()

    if (!running()) setRunning(true)
  }

  // Tool arguments are output tokens too, but the server publishes no
  // `session.tool.input.delta` events. Use the started/ended pair to cover the
  // time spent generating them, otherwise tool-heavy steps look absurdly fast.
  const toolStart = (sessionID: string, at: number) => {
    if (sessionID !== props.session.id) return
    markFirstToken(at > 0 ? at : Date.now())
  }

  const toolEnd = (sessionID: string, text: string, at: number) => {
    if (sessionID !== props.session.id) return

    const time = at > 0 ? at : Date.now()
    markFirstToken(time)
    lastActivityAt = Math.max(lastActivityAt, time)
    toolChars += text.length
  }

  const begin = (sessionID: string, started: number) => {
    if (sessionID !== props.session.id) return

    reset()
    startedAt = started > 0 ? started : Date.now()
    setLiveTtft(undefined)
    setRunning(true)
    setTick((value) => value + 1)
  }

  const finish = (
    sessionID: string,
    tokens: { output: number; reasoning: number },
    at: number,
  ) => {
    if (sessionID !== props.session.id) return

    const produced = Math.max(0, tokens.output + (props.countReasoning ? tokens.reasoning : 0))
    const end = at > 0 ? at : Date.now()
    const valid = startedAt > 0 && startedAt <= end

    // Reasoning tokens can be hidden: the provider reports them but streams no
    // reasoning deltas. Then the visible deltas start late, so measuring from the
    // first delta would inflate the rate. Fall back to the request start instead.
    const hiddenReasoning = tokens.reasoning > 0 && !sawReasoningDelta
    const ignoredReasoning = props.countReasoning && hiddenReasoning

    // The server coalesces deltas (~100ms) and some providers flush whole
    // chunks at once. A very short window means we only saw part of the stream,
    // so use the full step duration instead of reporting thousands of tok/s.
    const timingStart = firstCountedAt > 0 ? firstCountedAt : firstTokenAt
    const observedEnd = Math.max(streamedAt, lastActivityAt, lastDeltaAt)
    const observedSpan = timingStart > 0 && observedEnd >= timingStart ? observedEnd - timingStart : 0
    const reliable =
      !ignoredReasoning &&
      countedDeltas >= MIN_AVG_DELTAS &&
      observedSpan >= MIN_AVG_SPAN_MS

    if (produced > 0 && valid) {
      const from = reliable ? Math.max(startedAt, timingStart) : startedAt
      const to = reliable
        ? Math.max(from, observedEnd)
        : Math.max(from, streamedAt > 0 ? streamedAt : end)
      const ms = Math.max(1, to - from)

      setLast({ tps: produced / (ms / 1_000), tokens: produced, ms, approx: !reliable })

      const chars = stepChars + toolChars
      if (chars >= 32 && !ignoredReasoning) {
        const sample = clamp(chars / produced, RATIO_MIN, RATIO_MAX)
        ratio = ratio * 0.5 + sample * 0.5
      }
    }

    if (firstTokenAt > 0 && startedAt > 0) {
      setLastTtft({
        ms: Math.max(0, firstTokenAt - startedAt),
        approx: hiddenReasoning,
      })
    }

    reset()
    setRunning(false)
    setLiveTtft(undefined)
  }

  const stop = (sessionID: string) => {
    if (sessionID !== props.session.id) return
    reset()
    setRunning(false)
    setLiveTtft(undefined)
  }

  createKeyed(
    () => props.session.server.data,
    (data) => {
      const stops = [
        data.on("session.step.started", (event) => {
          begin(event.data.sessionID, event.data.started)
        }),
        data.on("session.text.delta", (event) => {
          push(event.data.sessionID, event.data.delta, event.created, "text")
        }),
        data.on("session.reasoning.delta", (event) => {
          push(event.data.sessionID, event.data.delta, event.created, "reasoning")
        }),
        data.on("session.tool.input.started", (event) => {
          toolStart(event.data.sessionID, event.created)
        }),
        data.on("session.tool.input.ended", (event) => {
          toolEnd(event.data.sessionID, event.data.text, event.created)
        }),
        data.on("session.step.streamed", (event) => {
          if (event.data.sessionID !== props.session.id) return
          const time = event.created > 0 ? event.created : Date.now()
          streamedAt = Math.max(streamedAt, time)
          lastActivityAt = Math.max(lastActivityAt, time)
        }),
        data.on("session.retry.scheduled", (event) => {
          // A retry starts a new attempt: measure TTFT from the retry, not from
          // the failed attempt plus backoff.
          begin(event.data.sessionID, event.data.at)
        }),
        data.on("session.step.ended", (event) => {
          finish(event.data.sessionID, event.data.tokens, event.created)
        }),
        data.on("session.step.failed", (event) => {
          if (event.data.tokens) finish(event.data.sessionID, event.data.tokens, event.created)
          else stop(event.data.sessionID)
        }),
        data.on("session.idle", (event) => {
          stop(event.data.sessionID)
        }),
        data.on("session.execution.failed", (event) => {
          stop(event.data.sessionID)
        }),
        data.on("session.execution.interrupted", (event) => {
          stop(event.data.sessionID)
        }),
      ]

      onCleanup(() => stops.forEach((unsubscribe) => unsubscribe()))
    },
  )

  // The header stays mounted while the routed session changes.
  createEffect(() => {
    props.session.key
    reset()
    setRunning(false)
    setLast(undefined)
    setLastTtft(undefined)
    setLiveTtft(undefined)
  })

  createEffect(() => {
    if (!running()) return

    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const estimatedTokens = () => (stepChars + toolChars) / ratio

  const live = (): number | undefined => {
    if (firstCountedAt === 0) return undefined

    const now = Date.now()
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
    // segment is better than showing a misleading ~0 tok/s.
    if (count === 0) return undefined

    const span = Math.max(MIN_SPAN_MS, now - from) / 1_000
    return chars / ratio / span
  }

  const liveView = (): Metric | undefined => {
    if (!running()) return undefined
    tick()

    const rate = live()
    if (rate === undefined) return undefined

    const elapsed = startedAt > 0 ? Math.max(0, Date.now() - startedAt) / 1_000 : 0
    return {
      label: `~${formatRate(rate)}${props.compact ? "" : " tok/s"}`,
      title: `本轮：≈ ${formatTokens(estimatedTokens())} tok · ${elapsed.toFixed(1)}s`,
    }
  }

  const avgView = (): Metric | undefined => {
    const done = last()
    if (!done) return undefined

    const prefix = done.approx ? "~" : ""
    return {
      label: `${prefix}${formatRate(done.tps)}${props.compact ? "" : " avg"}`,
      title: done.approx
        ? `上一轮：${formatTokens(done.tokens)} tok · ${(done.ms / 1_000).toFixed(1)}s（流式分块过粗，按整步耗时估算）`
        : `上一轮：${formatTokens(done.tokens)} tok · ${(done.ms / 1_000).toFixed(1)}s（不含 TTFT）`,
    }
  }

  const ttftView = (): Metric | undefined => {
    if (running()) {
      tick()

      const measured = liveTtft()
      if (measured !== undefined) {
        return {
          label: `TTFT ${formatSeconds(measured)}`,
          title: "首个 token 延迟",
        }
      }

      if (startedAt > 0) {
        const elapsed = Math.max(0, Date.now() - startedAt)
        return {
          label: `TTFT ${formatSeconds(elapsed)}…`,
          title: "等待首个 token",
        }
      }

      return undefined
    }

    const done = lastTtft()
    if (!done) return undefined

    const value = `${done.approx ? "~" : ""}${formatSeconds(done.ms)}`
    return {
      label: props.compact ? value : `TTFT ${value}`,
      title: done.approx
        ? `首个 token：${value}（reasoning 未流式输出，实际可能更早）`
        : `首个 token：${value}`,
    }
  }

  const cacheView = (): Metric | undefined => {
    const data = props.session.server.data
    if (data.session.missing(props.session.id)) return undefined

    const tokens = data.session.get(props.session.id)?.tokens
    if (!tokens) return undefined

    const read = Math.max(0, tokens.cache.read)
    const write = Math.max(0, tokens.cache.write)
    const input = Math.max(0, tokens.input)
    const total = input + read + write
    if (total <= 0) return undefined

    const rate = clamp(read / total, 0, 1)
    const percent = formatPercent(rate)
    return {
      label: props.compact ? percent : `cache ${percent}`,
      title: `会话缓存：${formatTokens(read)} read · ${formatTokens(write)} write · ${formatTokens(input)} new`,
    }
  }

  const liveMetric = createMemo(liveView)
  const avgMetric = createMemo(avgView)
  const ttftMetric = createMemo(ttftView)
  const cacheMetric = createMemo(cacheView)
  const hasAny = () => Boolean(liveMetric() || avgMetric() || ttftMetric() || cacheMetric())

  return (
    <Show when={hasAny()}>
      <span class="opencode-tps-badge">
        <Show when={liveMetric()}>
          {(metric) => (
            <span class="opencode-tps-item" data-live="true" title={metric().title}>
              {metric().label}
            </span>
          )}
        </Show>
        <Show when={avgMetric()}>
          {(metric) => (
            <span class="opencode-tps-item" title={metric().title}>
              {metric().label}
            </span>
          )}
        </Show>
        <Show when={ttftMetric()}>
          {(metric) => (
            <span class="opencode-tps-item" title={metric().title}>
              {metric().label}
            </span>
          )}
        </Show>
        <Show when={cacheMetric()}>
          {(metric) => (
            <span class="opencode-tps-item" title={metric().title}>
              {metric().label}
            </span>
          )}
        </Show>
      </span>
    </Show>
  )
}
