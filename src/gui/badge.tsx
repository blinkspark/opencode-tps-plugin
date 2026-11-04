import { Show, createEffect, createSignal, onCleanup } from "solid-js"
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
}

type Sample = {
  at: number
  chars: number
}

const WINDOW_MS = 2_000
const MIN_SPAN_MS = 350
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function TpsBadge(props: TpsBadgeProps) {
  const [running, setRunning] = createSignal(false)
  const [last, setLast] = createSignal<Last>()
  const [tick, setTick] = createSignal(0)

  // Characters per token, learned from the previous completed step. Providers and
  // languages differ a lot, so an adaptive ratio beats a fixed one.
  let ratio = DEFAULT_CHARS_PER_TOKEN
  let startedAt = 0
  let stepChars = 0
  let samples: Sample[] = []

  const reset = () => {
    startedAt = 0
    stepChars = 0
    samples = []
  }

  const push = (sessionID: string, delta: string, at: number) => {
    if (sessionID !== props.session.id || delta.length === 0) return

    const time = at > 0 ? at : Date.now()
    stepChars += delta.length
    samples.push({ at: time, chars: delta.length })

    const cutoff = time - WINDOW_MS
    while (samples.length > 0 && samples[0]!.at < cutoff) samples.shift()

    if (!running()) setRunning(true)
  }

  const begin = (sessionID: string, started: number) => {
    if (sessionID !== props.session.id) return

    startedAt = started > 0 ? started : Date.now()
    stepChars = 0
    samples = []
    setRunning(true)
    setTick((value) => value + 1)
  }

  const finish = (sessionID: string, tokens: { output: number; reasoning: number }, at: number) => {
    if (sessionID !== props.session.id) return

    const produced = Math.max(0, tokens.output + (props.countReasoning ? tokens.reasoning : 0))
    const end = at > 0 ? at : Date.now()
    const valid = startedAt > 0 && startedAt <= end

    if (produced > 0 && valid) {
      const ms = Math.max(1, end - startedAt)
      const tps = produced / (ms / 1_000)
      setLast({ tps, tokens: produced, ms })

      if (stepChars >= 32) {
        const sample = clamp(stepChars / produced, RATIO_MIN, RATIO_MAX)
        ratio = ratio * 0.5 + sample * 0.5
      }
    }

    reset()
    setRunning(false)
  }

  const stop = (sessionID: string) => {
    if (sessionID !== props.session.id) return
    reset()
    setRunning(false)
  }

  createKeyed(
    () => props.session.server.data,
    (data) => {
      const stops = [
        data.on("session.step.started", (event) => {
          begin(event.data.sessionID, event.data.started)
        }),
        data.on("session.text.delta", (event) => {
          push(event.data.sessionID, event.data.delta, event.created)
        }),
        data.on("session.reasoning.delta", (event) => {
          push(event.data.sessionID, event.data.delta, event.created)
        }),
        data.on("session.tool.input.delta", (event) => {
          push(event.data.sessionID, event.data.delta, event.created)
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
  })

  createEffect(() => {
    if (!running()) return

    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const live = () => {
    const now = Date.now()
    const from = Math.max(startedAt > 0 ? startedAt : now - WINDOW_MS, now - WINDOW_MS)

    let chars = 0
    for (const sample of samples) {
      if (sample.at >= from) chars += sample.chars
    }

    const span = Math.max(MIN_SPAN_MS, now - from) / 1_000
    return chars / ratio / span
  }

  const view = () => {
    if (running()) {
      tick()
      const elapsed = startedAt > 0 ? Math.max(0, Date.now() - startedAt) / 1_000 : 0
      return {
        live: true,
        label: `~${formatRate(live())}`,
        title: `≈ ${formatTokens(stepChars / ratio)} tok · ${elapsed.toFixed(1)}s`,
      }
    }

    const done = last()
    if (!done) return undefined

    return {
      live: false,
      label: formatRate(done.tps),
      title: `${formatTokens(done.tokens)} tok · ${(done.ms / 1_000).toFixed(1)}s`,
    }
  }

  return (
    <Show when={view()}>
      {(value) => (
        <span class="tps-badge" data-live={value().live ? "true" : "false"} title={value().title}>
          {value().label}
          {props.compact ? " t/s" : " tok/s"}
        </span>
      )}
    </Show>
  )
}
