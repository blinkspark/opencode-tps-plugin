// Offline regression checks for the TPS meter: pure metric math plus a tracker
// event simulation. No network and no real model calls.
//
//   npm run verify
//
// Needs Node >= 22.6 (type stripping). The tracker half copies the two source
// files into a gitignored `.verify/` directory at the repo root, so its
// extensionless "./metrics" import can be rewritten to "./metrics.ts" for the
// Node loader (type stripping is refused under node_modules).

import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const metricsPath = join(repoRoot, "src/gui/metrics.ts")
const { LONG_WAIT_MS, TOOL_RUN_CAP_MS, formatDuration, insertSpan, measureStep, rateOf, runtimeWithOpen, totalsOf } =
  await import(pathToFileURL(metricsPath).href)

// ---- 1. A real 108s step from ses_e36ed12f9ffdpQuH27... -------------------
// step.started.data.started = 1794375032216
// first reasoning part      = 1794375181571  (149.4s later)
// step.streamed             = 1794375184023
// step.ended                = 1794375184411
// tokens: output 223 + reasoning 124, flushed in one chunk
const startedAt = 1794375032216
const firstOutputAt = 1794375181571
const streamedAt = 1794375184023
const end = 1794375184411
const produced = 223 + 124

const m = measureStep({
  startedAt,
  firstOutputAt,
  firstCountedAt: firstOutputAt,
  lastDeltaAt: streamedAt,
  lastActivityAt: streamedAt,
  streamedAt,
  countedDeltas: 1,
  ignoredReasoning: false,
  end,
})

const oldTps = produced / ((end - startedAt) / 1_000)
const newTps = rateOf(produced, m.genMs)
console.log("long-wait step:", {
  ...m,
  waitS: +(m.waitMs / 1_000).toFixed(1),
  genS: +(m.genMs / 1_000).toFixed(2),
  oldTps: +oldTps.toFixed(2),
  newTps: +newTps.toFixed(2),
})

assert.equal(m.reliable, false, "one-shot flush is not a reliable window")
assert.equal(m.approx, true, "should carry the ~ marker")
assert.equal(m.longWait, true, "149s wait must be flagged")
assert.ok(m.waitMs > LONG_WAIT_MS)
assert.ok(m.genMs < 5_000, "genMs must exclude the 149s wait")
assert.ok(newTps > 50, "avg must not be ~1.8 tok/s anymore")
assert.ok(newTps > oldTps * 10, "avg must be far above the old full-step value")

// ---- 2. totalsOf keeps waiting out of the denominator --------------------
const entries = [
  { id: "a", tokens: 100, genMs: 1_000, waitMs: 0, approx: false, longWait: false, fromHistory: false, at: 1 },
  { id: "b", tokens: 200, genMs: 2_000, waitMs: 108_000, approx: true, longWait: true, fromHistory: false, at: 2 },
  { id: "c", tokens: 50, genMs: 500, waitMs: 0, approx: true, longWait: false, fromHistory: true, at: 3 },
]
const t = totalsOf(entries)
console.log("totals:", t, "sessionTps:", +rateOf(t.tokens, t.ms).toFixed(2))

assert.equal(t.tokens, 350)
assert.equal(t.ms, 3_500, "waitMs must NOT enter the denominator")
assert.equal(t.waitMs, 108_000, "waitMs is reported separately")
assert.equal(t.longWaitSteps, 1)
assert.equal(t.steps, 3)
assert.ok(rateOf(t.tokens, t.ms) > 90)
assert.equal(t.approxMs, 2_500)

// ---- 3. Normal streaming step stays precise and excludes TTFT -------------
const n = measureStep({
  startedAt: 200,
  firstOutputAt: 1_000,
  firstCountedAt: 1_000,
  lastDeltaAt: 5_000,
  lastActivityAt: 5_000,
  streamedAt: 5_000,
  countedDeltas: 10,
  ignoredReasoning: false,
  end: 5_100,
})
console.log("normal step:", n)
assert.equal(n.reliable, true)
assert.equal(n.approx, false)
assert.equal(n.genMs, 4_000)
assert.equal(n.waitMs, 800)
assert.equal(n.longWait, false)

// ---- 4. Hidden reasoning with no visible event falls back -----------------
const h = measureStep({
  startedAt: 0,
  firstOutputAt: 0,
  firstCountedAt: 0,
  lastDeltaAt: 0,
  lastActivityAt: 0,
  streamedAt: 3_000,
  countedDeltas: 0,
  ignoredReasoning: true,
  end: 3_100,
})
console.log("hidden reasoning:", h)
assert.equal(h.reliable, false)
assert.ok(h.genMs >= 3_000, "falls back to full step duration")

// ---- 5. Tool-only step: window starts at the tool input, not the request --
// TTFT itself is not computed here: tracker only uses firstTextAt for that.
const tool = measureStep({
  startedAt: 1_000,
  firstOutputAt: 2_000,
  firstCountedAt: 0,
  lastDeltaAt: 0,
  lastActivityAt: 5_000,
  streamedAt: 6_000,
  countedDeltas: 0,
  ignoredReasoning: false,
  end: 6_100,
})
console.log("tool-only step:", tool)
assert.equal(tool.reliable, false)
assert.equal(tool.waitMs, 1_000, "wait ends at the first tool output")
assert.equal(tool.genMs, 4_000, "window is tool output -> stream end")
assert.equal(tool.longWait, false)
assert.equal(rateOf(80, tool.genMs), 20)

// ---- 6. Run intervals: union, open windows and the tool cap --------------
const spans = []
assert.equal(insertSpan(spans, 1_000, 2_000), 1_000)
assert.deepEqual(spans, [{ start: 1_000, end: 2_000 }])
assert.equal(insertSpan(spans, 1_500, 3_000), 1_000, "overlap adds only the new tail")
assert.deepEqual(spans, [{ start: 1_000, end: 3_000 }])
assert.equal(insertSpan(spans, 500, 700), 200)
assert.deepEqual(spans, [
  { start: 500, end: 700 },
  { start: 1_000, end: 3_000 },
])
assert.equal(insertSpan(spans, 600, 2_000), 300, "bridges the two intervals")
assert.deepEqual(spans, [{ start: 500, end: 3_000 }])
assert.equal(insertSpan(spans, 1_000, 1_500), 0, "a contained interval adds nothing")

const closed = { spans: [{ start: 0, end: 1_000 }], totalMs: 1_000, open: [], capped: 0 }
assert.equal(runtimeWithOpen(closed, 99_000), 1_000, "idle time does not grow")
assert.equal(
  runtimeWithOpen({ ...closed, open: [{ start: 1_000, tool: false }] }, 4_000),
  4_000,
  "an open step grows with the clock",
)
assert.equal(
  runtimeWithOpen({ ...closed, open: [{ start: 1_000, tool: true }] }, 1_000 + TOOL_RUN_CAP_MS * 3),
  1_000 + TOOL_RUN_CAP_MS,
  "an open tool stops at the cap",
)

assert.equal(formatDuration(59_000), "59s")
assert.equal(formatDuration(90_000), "1m 30s")
assert.equal(formatDuration(3_600_000), "1h")
assert.equal(formatDuration(3_723_000), "1h 2m")

// ---- 7. Tracker: TTFT and run-time event simulation ------------------------
// Node refuses type stripping under node_modules, so the copies live in a
// gitignored `.verify/` directory at the repo root.
const trackerDir = join(repoRoot, ".verify")
mkdirSync(trackerDir, { recursive: true })
writeFileSync(join(trackerDir, "metrics.ts"), readFileSync(metricsPath, "utf8"))
writeFileSync(
  join(trackerDir, "tracker.ts"),
  readFileSync(join(repoRoot, "src/gui/tracker.ts"), "utf8").replace(
    'from "./metrics"',
    'from "./metrics.ts"',
  ),
)

const tracker = await import(pathToFileURL(join(trackerDir, "tracker.ts")).href)

const handlers = new Map()
const data = {
  on(type, handler) {
    handlers.set(type, handler)
    return () => handlers.delete(type)
  },
}
const emit = (type, created, payload) => {
  const handler = handlers.get(type)
  assert.ok(handler, `no handler registered for ${type}`)
  handler({ type, created, data: payload })
}
const tokens = (output) => ({
  input: 100,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

tracker.attach(data, "srv")
const SES = { sessionID: "ses_test" }
const snap = () => tracker.snapshot("srv", SES.sessionID)

// Attempt 1 streams text and then fails. Its 500ms latency must not reach the
// main display or the TTFT average, and its partial tokens must not enter the
// session average.
emit("session.step.started", 1_000_000, { ...SES, started: 1_000_000 })
emit("session.text.delta", 1_000_500, { ...SES, delta: "hello" })
emit("session.step.failed", 1_001_500, {
  ...SES,
  assistantMessageID: "msg_1",
  tokens: tokens(5),
})

assert.equal(snap().ttft, undefined, "a failed attempt must not set the main TTFT")
assert.equal(snap().ttftAverage.steps, 0, "a failed attempt must not enter the average")
assert.equal(snap().entries.size, 0, "a failed attempt must not enter the session average")
assert.equal(snap().run.totalMs, 1_500, "a failed attempt still spent run time")
assert.equal(snap().running, false)

// The retry succeeds: exactly one observation, owned by the retry.
const retryAt = 1_030_000
emit("session.step.started", retryAt, { ...SES, started: retryAt })
emit("session.text.delta", retryAt + 800, { ...SES, delta: "world" })
assert.equal(
  runtimeWithOpen(snap().run, retryAt + 1_000),
  2_500,
  "the open retry ticks on top of the failed attempt",
)
emit("session.step.ended", retryAt + 2_000, {
  ...SES,
  assistantMessageID: "msg_1",
  tokens: tokens(8),
})

assert.equal(snap().ttft.ms, 800, "the successful retry owns the TTFT")
assert.equal(snap().ttft.stale, false)
assert.equal(snap().ttftAverage.steps, 1, "one completed step, despite two attempts")
assert.equal(snap().ttftAverage.totalMs, 800)
assert.equal(snap().entries.size, 1, "only the successful attempt creates an entry")
assert.equal(snap().entries.get("msg_1")?.tokens, 8, "the retry's tokens, not the failed attempt's")
assert.equal(snap().run.totalMs, 3_500, "both the failed attempt and the retry count")

// A later attempt fails with no text at all: nothing changes, and it must not
// be mislabelled as a tool-only step.
const failedAt = 1_060_000
emit("session.step.started", failedAt, { ...SES, started: failedAt })
emit("session.step.failed", failedAt + 500, {
  ...SES,
  assistantMessageID: "msg_2",
  tokens: tokens(0),
})

assert.equal(snap().ttft.ms, 800, "a later failure keeps the last successful value")
assert.equal(snap().ttft.stale, false, "a failure is not a tool-only step")
assert.equal(snap().ttftAverage.steps, 1)
assert.equal(snap().entries.size, 1, "a failed attempt must not add a session entry")
assert.equal(snap().run.totalMs, 4_000, "a failed attempt with no text still counts for run time")

// A successful tool-only step keeps the previous value, marks it stale, and
// stays out of the average.
const toolAt = 1_120_000
emit("session.step.started", toolAt, { ...SES, started: toolAt })
emit("session.tool.input.started", toolAt + 400, { ...SES })
emit("session.tool.input.ended", toolAt + 600, { ...SES, text: '{"path":"a.ts"}' })
emit("session.step.ended", toolAt + 1_200, {
  ...SES,
  assistantMessageID: "msg_3",
  tokens: tokens(12),
})

assert.equal(snap().ttft.ms, 800)
assert.equal(snap().ttft.stale, true, "a successful tool-only step marks the value stale")
assert.equal(snap().ttftAverage.steps, 1, "tool-only steps stay out of the average")
assert.equal(snap().run.totalMs, 5_200, "a tool-only step still counts as run time")

// Tool execution expands the window beyond the step that requested it, but
// only from `tool.called` (after any permission prompt) to success/failure.
emit("session.tool.called", toolAt + 1_300, {
  ...SES,
  assistantMessageID: "msg_3",
  id: "call_1",
  input: {},
  executed: true,
})
assert.equal(
  runtimeWithOpen(snap().run, toolAt + 3_300),
  7_200,
  "a running tool keeps the clock going",
)
emit("session.tool.success", toolAt + 5_300, {
  ...SES,
  assistantMessageID: "msg_3",
  id: "call_1",
  content: [],
  executed: true,
})
assert.equal(snap().run.totalMs, 9_200, "tool execution is part of run time")
assert.equal(snap().run.capped, 0)

// A tool that never returns is capped instead of counting an overnight hang.
const hangAt = 2_000_000
emit("session.tool.called", hangAt, {
  ...SES,
  assistantMessageID: "msg_4",
  id: "call_hang",
  input: {},
  executed: true,
})
emit("session.idle", hangAt + 43 * 3_600_000, { ...SES })
assert.equal(snap().run.totalMs, 9_200 + TOOL_RUN_CAP_MS, "a hung tool stops at 30 minutes")
assert.equal(snap().run.capped, 1)
assert.equal(snap().run.open.length, 0, "idle closes every open interval")

// Transcript seeding unions step/tool intervals and is idempotent.
const seedSES = { sessionID: "ses_seed" }
const seedSnap = () => tracker.snapshot("srv", seedSES.sessionID)
tracker.seedRun("srv", seedSES.sessionID, "step:a:20000", 10_000, 20_000, false)
assert.equal(seedSnap().run.totalMs, 10_000)
tracker.seedRun("srv", seedSES.sessionID, "step:a:20000", 10_000, 20_000, false)
assert.equal(seedSnap().run.totalMs, 10_000, "re-reading a message cannot double count")
tracker.seedRun("srv", seedSES.sessionID, "tool:a:call:25000", 15_000, 25_000, true)
assert.equal(seedSnap().run.totalMs, 15_000, "a tool overlapping its step is unioned")
tracker.seedRun("srv", seedSES.sessionID, "tool:b:call:long", 30_000, 30_000 + 2 * 3_600_000, true)
assert.equal(seedSnap().run.totalMs, 15_000 + TOOL_RUN_CAP_MS, "seeded tools are capped")
assert.equal(seedSnap().run.capped, 1)

// The same long tool can arrive live first and from the transcript later; the
// cap must be counted once, not twice.
const dupSES = { sessionID: "ses_dup" }
const dupAt = 5_000_000
emit("session.tool.called", dupAt, { ...dupSES, assistantMessageID: "msg_dup", id: "call_dup", input: {}, executed: true })
emit("session.tool.success", dupAt + TOOL_RUN_CAP_MS * 2, {
  ...dupSES,
  assistantMessageID: "msg_dup",
  id: "call_dup",
  content: [],
  executed: true,
})
tracker.seedRun("srv", dupSES.sessionID, "tool:dup:1", dupAt, dupAt + TOOL_RUN_CAP_MS * 2, true)
const dupRun = tracker.snapshot("srv", dupSES.sessionID).run
assert.equal(dupRun.totalMs, TOOL_RUN_CAP_MS, "the transcript copy adds no time")
assert.equal(dupRun.capped, 1, "the transcript copy does not double count the cap")

tracker.dispose()
rmSync(trackerDir, { recursive: true, force: true })
console.log("tracker TTFT and run-time assertions passed.")

console.log("\nAll metric replay assertions passed.")
