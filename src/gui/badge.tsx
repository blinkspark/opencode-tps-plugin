import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MountedSession } from "@opencode/plugin/gui"
import * as tracker from "./tracker"
import {
  TICK_MS,
  clamp,
  formatDuration,
  formatPercent,
  formatRate,
  formatSeconds,
  formatTokens,
  latestStep,
  liveRate,
  rateOf,
  totalsOf,
} from "./metrics"

export interface TpsBadgeProps {
  session: MountedSession
  compact: boolean
  active: boolean
  countReasoning: boolean
}

type Metric = {
  label: string
  title: string
  live?: boolean
  fallback?: boolean
}

export function TpsBadge(props: TpsBadgeProps) {
  const [tick, setTick] = createSignal(0)

  // The global subscription lives in the tracker's own owner, so this is
  // idempotent even when several headers (cached tabs) mount at once.
  createEffect(() => {
    tracker.attach(props.session.server.data, props.session.server.id)
  })

  // Seed from the transcript already loaded in the client. Observed steps win
  // over these entries when both refer to the same assistantMessageID.
  createEffect(() => {
    const data = props.session.server.data
    const serverID = props.session.server.id
    const sessionID = props.session.id
    const messages = data.session.message.list(sessionID)

    for (const message of messages) {
      if (message.type !== "assistant" || !message.tokens) continue

      const end = message.time.streamed ?? message.time.completed
      if (!end) continue

      const produced = Math.max(
        0,
        message.tokens.output + (props.countReasoning ? message.tokens.reasoning : 0),
      )
      tracker.seedStep(serverID, sessionID, message.id, produced, message.time.created, end)
    }
  })

  const running = createMemo(() => {
    tracker.version()
    return tracker.snapshot(props.session.server.id, props.session.id).running
  })

  createEffect(() => {
    if (!props.active || !running()) return

    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS)
    onCleanup(() => clearInterval(timer))
  })

  const mergeView = (): Metric | undefined => {
    tracker.version()
    tick()

    const state = tracker.snapshot(props.session.server.id, props.session.id)
    const done = latestStep(state.entries.values())
    const lastTps = done ? rateOf(done.tokens, done.genMs) : undefined
    const lastPrefix = done?.approx ? "~" : ""
    const lastLabel = done
      ? `${lastPrefix}${formatRate(lastTps!)}${props.compact ? "" : " avg"}`
      : undefined
    const lastDetail = done
      ? `上一轮：${lastPrefix}${formatRate(lastTps!)} tok/s（${formatTokens(done.tokens)} tok / ${formatSeconds(done.genMs)}${done.approx ? "，按可见窗口估算" : "，不含 TTFT 与长等待"}）`
      : undefined

    if (state.running) {
      const rate = liveRate(state.live.samples, state.live.firstCountedAt, state.live.ratio, Date.now())

      if (rate !== undefined) {
        const elapsed = state.live.startedAt > 0 ? Math.max(0, Date.now() - state.live.startedAt) / 1_000 : 0
        return {
          label: `~${formatRate(rate)}${props.compact ? "" : " tok/s"}`,
          title: [
            `本轮：≈ ${formatTokens((state.live.stepChars + state.live.toolChars) / state.live.ratio)} tok · ${elapsed.toFixed(1)}s`,
            lastDetail,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          live: true,
        }
      }

      // Waiting for the first token, or inside a tool call: show the previous
      // step dimmed instead of an empty slot or a misleading ~0 tok/s.
      if (done) {
        return {
          label: lastLabel!,
          title: ["实时值暂不可用（等待首 token / 工具执行中）", lastDetail!].join("\n"),
          fallback: true,
        }
      }

      return undefined
    }

    if (!done) return undefined
    return { label: lastLabel!, title: lastDetail! }
  }

  const sessionView = (): Metric | undefined => {
    tracker.version()

    const state = tracker.snapshot(props.session.server.id, props.session.id)
    const totals = totalsOf(state.entries.values())
    if (totals.steps === 0) return undefined

    const suffix = totals.approxMs > totals.ms / 2 ? "~" : ""
    const tps = rateOf(totals.tokens, totals.ms)

    const lines = [
      `本会话平均：${suffix}${formatRate(tps)} tok/s`,
      `已统计 ${formatTokens(totals.tokens)} tok / ${formatDuration(totals.ms)} · ${totals.steps} 步`,
    ]
    if (totals.longWaitSteps > 0) {
      lines.push(`${totals.longWaitSteps} 步含长等待（等待 ${formatDuration(totals.waitMs)} 未计入）`)
    }
    if (totals.approxMs > 0) lines.push("部分 step 按整步耗时估算")
    if (props.session.server.data.session.message.more(props.session.id)) {
      lines.push("仅统计已加载的消息，更早的历史未计入")
    }

    return {
      label: `${suffix}${formatRate(tps)}${props.compact ? "" : " sess"}`,
      title: lines.join("\n"),
    }
  }

  const ttftView = (): Metric | undefined => {
    tracker.version()
    tick()

    const state = tracker.snapshot(props.session.server.id, props.session.id)
    const average = state.ttftAverage
    const averageLine =
      average.steps > 0
        ? `平均：${formatSeconds(average.totalMs / average.steps)}（${average.steps} 步${
            average.longWaitSteps > 0 ? `，含 ${average.longWaitSteps} 步长等待` : ""
          }）`
        : undefined

    if (state.running) {
      if (state.live.firstTextAt > 0 && state.live.startedAt > 0) {
        const measured = Math.max(0, state.live.firstTextAt - state.live.startedAt)
        return {
          label: `TTFT ${formatSeconds(measured)}`,
          title: ["首个 token 延迟（当前步）", ...(averageLine ? [averageLine] : [])].join("\n"),
        }
      }

      if (state.live.startedAt > 0) {
        const elapsed = Math.max(0, Date.now() - state.live.startedAt)
        return {
          label: `TTFT ${formatSeconds(elapsed)}…`,
          title: ["等待首个 token", ...(averageLine ? [averageLine] : [])].join("\n"),
        }
      }

      return undefined
    }

    const done = state.ttft
    if (!done) return undefined

    const mark = done.approx || done.longWait ? "~" : ""
    const value = `${mark}${formatSeconds(done.ms)}`
    const notes = [
      ...(done.stale ? ["本步只有工具调用，沿用上一步"] : []),
      ...(done.longWait ? ["含排队/等待，非纯生成延迟"] : []),
      ...(done.approx ? ["reasoning 未流式输出，实际可能更早"] : []),
    ]
    const lines = [
      notes.length > 0 ? `首个 token：${value}（${notes.join("；")}）` : `首个 token：${value}`,
      ...(averageLine ? [averageLine] : []),
    ]

    return {
      label: props.compact ? value : `TTFT ${value}`,
      title: lines.join("\n"),
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

  const mergeMetric = createMemo(mergeView)
  const sessionMetric = createMemo(sessionView)
  const ttftMetric = createMemo(ttftView)
  const cacheMetric = createMemo(cacheView)
  const hasAny = () => Boolean(mergeMetric() || sessionMetric() || ttftMetric() || cacheMetric())

  return (
    <Show when={hasAny()}>
      <span class="opencode-tps-badge">
        <Show when={mergeMetric()}>
          {(metric) => (
            <span
              class="opencode-tps-item"
              data-live={metric().live ? "true" : undefined}
              data-fallback={metric().fallback ? "true" : undefined}
              title={metric().title}
            >
              {metric().label}
            </span>
          )}
        </Show>
        <Show when={sessionMetric()}>
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
