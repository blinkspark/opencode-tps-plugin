import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"

export interface TpsBadgeProps {
  session: MountedSession
  compact: boolean
  countReasoning: boolean
}

type StepEntry = {
  id: string
  tokens: number
  ms: number
  approx: boolean
  at: number
}

type SessionStat = {
  countReasoning: boolean
  entries: Map<string, StepEntry>
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

// Session totals outlive the header badge so switching sessions (or remounting
// the header) does not throw away what we already measured. Keyed by
// `MountedSession.key`, which is unique across servers.
const sessionStats = new Map<string, SessionStat>()

function createStat(countReasoning: boolean): SessionStat {
  return { countReasoning, entries: new Map() }
}

function mergeStep(stat: SessionStat, step: StepEntry): SessionStat {
  const previous = stat.entries.get(step.id)

  // Prefer the precise delta-timed measurement once it arrives. The message
  // store may publish the same step first, with only full-step timing.
  if (previous) {
    if (!previous.approx) return stat
    if (step.approx) return stat
  }

  const entries = new Map(stat.entries)
  entries.set(step.id, step)
  return { ...stat, entries }
}

function totalsOf(stat: SessionStat) {
  let tokens = 0
  let ms = 0
  let approxMs = 0

  for (const step of stat.entries.values()) {
    tokens += step.tokens
    ms += step.ms
    if (step.approx) approxMs += step.ms
  }

  return { tokens, ms, approxMs, steps: stat.entries.size }
}

function latestStep(stat: SessionStat): StepEntry | undefined {
  let latest: StepEntry | undefined

  for (const step of stat.entries.values()) {
    if (!latest || step.at >= latest.at) latest = step
  }

  return latest
}

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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 60_000) return formatSeconds(ms)

  const seconds = Math.round(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function TpsBadge(props: TpsBadgeProps) {
  const [running, setRunning] = createSignal(false)
  const [lastTtft, setLastTtft] = createSignal<Ttft>()
  const [liveTtft, setLiveTtft] = createSignal<number>()
  const [tick, setTick] = createSignal(0)

  const ensureStat = (key: string) => {
    let stat = sessionStats.get(key)

    // The option is read once per plugin setup; if it changes on a hot reload,
    // start over rather than mixing reasoning counts.
    if (!stat || stat.countReasoning !== props.countReasoning) {
      stat = createStat(props.countReasoning)
      sessionStats.set(key, stat)
    }

    return stat
  }

  const [sessionStat, setSessionStat] = createSignal<SessionStat>(ensureStat(props.session.key))

  const recordStep = (step: StepEntry) => {
    const key = props.session.key
    const current = ensureStat(key)
    const next = mergeStep(current, step)

    if (next !== current) sessionStats.set(key, next)
    setSessionStat(next === current ? current : next)
  }

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
    assistantMessageID: string,
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

      recordStep({
        id: assistantMessageID,
        tokens: produced,
        ms,
        approx: !reliable,
        at: end,
      })

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
          finish(event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.created)
        }),
        data.on("session.step.failed", (event) => {
          if (event.data.tokens) {
            finish(event.data.sessionID, event.data.assistantMessageID, event.data.tokens, event.created)
          } else {
            stop(event.data.sessionID)
          }
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
    setLastTtft(undefined)
    setLiveTtft(undefined)
  })

  // Seed session totals from the transcript already loaded in the client. Later
  // steps arrive through `session.step.ended`; this also catches steps that
  // finished while another session was routed.
  createEffect(() => {
    const key = props.session.key
    const data = props.session.server.data
    const messages = data.session.message.list(props.session.id)
    let stat = ensureStat(key)

    for (const message of messages) {
      if (message.type !== "assistant" || !message.tokens) continue

      const end = message.time.streamed ?? message.time.completed
      if (!end) continue

      const produced = Math.max(
        0,
        message.tokens.output + (props.countReasoning ? message.tokens.reasoning : 0),
      )
      if (produced <= 0) continue

      stat = mergeStep(stat, {
        id: message.id,
        tokens: produced,
        ms: Math.max(1, end - message.time.created),
        approx: true,
        at: end,
      })
    }

    if (stat !== sessionStats.get(key)) sessionStats.set(key, stat)
    setSessionStat(stat)
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
    const stat = sessionStat()
    const done = latestStep(stat)
    if (!done) return undefined

    const totals = totalsOf(stat)
    const sessionSuffix = totals.approxMs > totals.ms / 2 ? "~" : ""
    const sessionTps = totals.tokens / (Math.max(1, totals.ms) / 1_000)
    const lastTps = done.tokens / (Math.max(1, done.ms) / 1_000)
    const prefix = done.approx ? "~" : ""

    const title = [
      `本会话平均：${sessionSuffix}${formatRate(sessionTps)} tok/s`,
      `已统计 ${formatTokens(totals.tokens)} tok / ${formatDuration(totals.ms)} · ${totals.steps} 步`,
      ...(totals.approxMs > 0 ? ["部分 step 按整步耗时估算"] : []),
      `上一轮：${prefix}${formatRate(lastTps)} tok/s（${formatTokens(done.tokens)} tok / ${formatSeconds(done.ms)}${done.approx ? "，整步估算" : "，不含 TTFT"}）`,
      ...(props.session.server.data.session.message.more(props.session.id)
        ? ["仅统计已加载的消息，更早的历史未计入"]
        : []),
    ].join("\n")

    return {
      label: `${prefix}${formatRate(lastTps)}${props.compact ? "" : " avg"}`,
      title,
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
