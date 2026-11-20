<img src="https://raw.githubusercontent.com/blinkspark/opencode-tps-plugin/main/assets/icon.svg" width="88" height="88" alt="TPS meter icon" align="right" />

# @blinkspark/opencode-tps-plugin

在 OpenCode Desktop 的**会话标题栏**显示实时 / 上一轮 / 本会话平均 tokens per second、首 token 延迟和缓存命中率，并在会话平均的悬停里显示不含空闲的运行时间。

四段，单行：

- 生成中：`~41 tok/s · 42 sess · TTFT 0.9s · cache 87%`
- 结束后：`38 avg · 42 sess · TTFT 0.9s · cache 87%`
- 紧凑：`~41 · 42 · 0.9s · 87%` / `38 · 42 · 0.9s · 87%`

| 段 | 显示 | 说明 |
| --- | --- | --- |
| 实时 / 上一轮（合并） | 生成中 `~41 tok/s`，结束后 `38 avg` | 两段共用一个位置，互斥显示。生成中但 2 秒窗口没有新增量（等首 token、工具执行）时回退显示上一轮并置灰 |
| 本会话平均 | `42 sess` | 始终显示；估算值带 `~` |
| TTFT | `TTFT 0.9s` | 首 token 延迟；等待首 token 时实时累加（`TTFT 1.2s…`） |
| 缓存 | `cache 87%` | 当前会话累计的输入缓存命中率 |

- 悬停：合并段显示本轮 / 上一轮明细；会话平均段显示已统计 token、耗时、步数、本会话运行时间、长等待与估算说明；TTFT / 缓存段显示各自明细。
- 每步结束：实时值切回上一轮平均值，并**一直保留**到下一次生成，颜色变淡；会话平均同时累计。
- 切换会话或 tab 后统计不会丢失：事件由全局 tracker 按 `sessionID` 分桶记录，状态保存在插件内。

插件 id：`blinkspark-tps-meter`。测试于 OpenCode Desktop `2.2.5`。

## 安装

```bash
opencode plugin add @blinkspark/opencode-tps-plugin
```

或者手动写入全局配置 `~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "plugins": ["@blinkspark/opencode-tps-plugin"],
}
```

OpenCode Desktop 只从全局 `opencode.json(c)` 加载 GUI 插件。

## 配置项

需要改行为时，把条目换成对象形式：

```jsonc
{
  "plugins": [
    {
      "package": "@blinkspark/opencode-tps-plugin",
      "options": {
        "countReasoning": true,
      },
    },
  ],
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `countReasoning` | `true` | 是否把 reasoning tokens 计入 TPS 与总量；关闭时 reasoning 流式增量会被忽略，但 TTFT 仍把 reasoning 事件视作首个 token |

## 本地开发

把插件目录本身配置进 `opencode.jsonc` 即可，无需发布：

```jsonc
{
  "plugins": ["E:/dev/tps-plugin"],
}
```

需要 Node.js（≥ 22.6，`verify` 依赖类型剥离）与 npm：

```bash
npm install
npm run build      # 产出 dist/gui-experimental.cjs
npm run typecheck
npm run verify     # 离线回归：指标计算 + tracker 事件模拟，不发真实请求
npm run watch      # 监听构建；GUI 热重载不稳定，加载新 bundle 通常需重启 Desktop
```

## 发布

```bash
npm login --registry=https://registry.npmjs.org/
npm publish        # publishConfig 已指定官方源与 public
```

`prepublishOnly` 会先执行构建和类型检查。完整的发布流程、2FA 处理、验证与常见错误见 [docs/PUBLISH.md](docs/PUBLISH.md)。

## 结构

```
src/index.ts         服务端部分（Plugin.define，id: blinkspark-tps-meter）
src/gui.tsx          GUI 入口：注册样式与 session.header slot
src/gui/badge.tsx    视图：四段渲染、合并逻辑、tooltip
src/gui/tracker.ts   全局事件订阅、按 sessionID 分桶的状态机
src/gui/metrics.ts   纯计算：窗口、等待拆分、汇总、格式化
src/gui/badge.css    徽标样式
scripts/verify-metrics.mjs  离线回归：指标计算 + tracker 事件模拟（npm run verify）
dist/gui-experimental.cjs   构建产物（GUI 部分必须为单个 CJS 文件）
```

## 计算方式

| 指标 | 数据来源 | 口径 |
| --- | --- | --- |
| 实时 TPS | `session.text.delta` / `session.reasoning.delta` 的字符数，2 秒滑动窗口 | 估算值，带 `~`；字符/token 比例从上一个完成的 step 自适应学习 |
| 上一轮平均 | `session.step.ended.data.tokens` | `(output + reasoning) / 生成窗口`，排除 TTFT 与长等待 |
| 本会话平均 | 已加载的 assistant message（跳过出错 / 中止的）+ 观测到的 `session.step.ended` | `Σ(output + reasoning) / Σ生成窗口`，按 `assistantMessageID` 去重；失败 / 重试 attempt 不计入；长等待不计入分母 |
| 本会话运行时间 | 观测到的 `session.step.*` / `session.tool.*` + 已加载消息的 `time.created → time.completed` / `time.ran → time.completed` | 模型 step 与工具执行区间的**并集**；不含空闲、权限确认与重试退避；单次工具超过 30 分钟按 30 分钟计；失败 / 中断轮次中实际跑过的时间计入 |
| 首 token 延迟 | `session.step.started.data.started` → 首个 text / reasoning 事件 | **只认 text / reasoning 的 `started` / `delta`**；工具调用参数只用于生成窗口，不计入 TTFT；即使 `countReasoning: false` 也算；**失败 / 重试的 attempt 不计入** |
| 缓存命中率 | 会话累计 `tokens` | `cache.read / (input + cache.read + cache.write)` |

`tokens.input` 是非缓存输入，所以分母要把 `cache.read` 和 `cache.write` 加回来。缓存率是**会话累计**，切换会话会跟着变；首次请求通常是 0%。

生成窗口优先使用 `session.step.streamed`（stream 结束时刻），并覆盖 `session.tool.input.started` / `.ended`，因为工具参数的 token 也计入 `tokens.output`，但服务端不会发送 `tool.input.delta`。

服务端会把增量按约 100ms 合并后发布，且部分 provider 会整块 flush。如果观察窗口短于 500ms、有效 delta 少于 3 个，或模型隐藏了 reasoning，平均值会按「首个可见 token → stream 结束」计算并标 `~`（设 250ms 下限，避免除出几千 tok/s）；**只有完全没有可见事件的 step 才退回整步耗时**。整步耗时不再包含 TTFT 与排队等待。

**长等待**：请求开始到首个可见 token 超过 10 秒（provider 排队、限流、代理等待、隐藏 reasoning）时，等待时间单独记录，**不计入生成窗口，也不计入会话平均的分母**；TTFT 会标 `~` 并注明「含排队/等待，非纯生成延迟」，会话平均的 tooltip 会列出未计入的等待总时长。这一步不会再把 108 秒的等待显示成 `~1.8 avg`。

会话平均不会主动拉取完整的历史消息，只统计当前已加载的 assistant message（桌面端约最近 20/40 条）和插件之后观测到的 step；如果还有更早的历史未加载，悬停信息会注明。累计耗时中超过一半来自估算时，会话平均也会标 `~`。

纯工具调用的 step 没有 text / reasoning token，TTFT 会沿用上一次有文本输出的成功 step 的值，并在 tooltip 注明「上一步只有工具调用，沿用更早一次的值」；该 step 的生成窗口仍从工具参数开始，因此不影响平均速度。

TTFT 主显示**上一轮**（最近一个**成功完成**且产出 text / reasoning 的 step）的值；悬停额外显示「平均：1.1s（12 步）」。平均只累计插件观测到、且成功完成的 step：纯 tool-call step 不计入，**失败和重试中失败的 attempt 也不计入**（重试成功后按成功那次计一次）。命中过长等待的 step 会注明「含 N 步长等待」。生成中悬停显示的是已完成 step 的平均，不包含当前步。

会话平均（`sess`）同样只统计成功完成的 step：失败 attempt 的部分 token 不计入，重试成功后按成功那次的 token / 耗时计一次。

**运行时间**（`sess` 悬停）统计模型 step 与工具执行区间的并集：step 从 `step.started` 到 `step.ended` / `step.failed`（含首 token 等待），工具从 `tool.called` 到 `tool.success` / `tool.failed`。权限确认发生在 `tool.called` 之前，重试退避发生在两次 `step.started` 之间，因此都不计入；后台 shell 与 compaction 也不计入。单个工具超过 30 分钟按 30 分钟封顶，悬停里会注明封顶次数。失败 / 中断轮次中实际已经跑过的时间会保留——运行时间描述的是忙碌时长，不做质量过滤。事件流断开或切换到别的会话后，重新打开时会用已加载消息回填。

`session.retry.scheduled` 不参与计时：它的 `at` 是未来的 `nextRetryAt`，每次重试都会紧随一个新的 `session.step.started`。

## 已知限制

- 实时值是估算，最终以服务端 token 统计为准。
- TTFT 只统计 text / reasoning 的首 token；纯工具调用的 step 沿用上一步的值（tooltip 会标注）；失败 / 重试的 attempt 不更新主显示，也不计入平均。
- TTFT 平均只包含插件观测到的、成功完成的 step；已加载的历史消息没有 first-token 时间戳，无法补算。
- 工具参数的 token 计入平均值分子，其生成时间按 `tool.input.started` / `.ended` 估算；服务端不提供更细的时序。
- 会话平均只统计已加载的会话消息和插件观测到的 step；**已加载的历史消息没有首 token 时间戳，无法拆分等待，仍按整步耗时并标 `~`**。不会为了统计去拉取完整历史。
- 中断或执行失败会丢弃正在进行中的 step 的实时统计（没有完成的 `step.ended` / 带 tokens 的 `step.failed`），不会写入会话平均；该 step 在重新加载后由已加载消息补齐。
- 失败的 attempt（含自动重试前的失败）不计入会话平均；重新加载消息时出错 / 中止的 assistant message 也会跳过。若最终失败且从未成功，该 step 不贡献统计。
- 运行时间对单次工具封顶 30 分钟；后台 shell（`session.shell.*`）和 compaction 不计入。
- 运行时间的历史回填只能看到 assistant message 最终保留的 `time.created`：重试会覆盖同一 message 的起始时间，所以重新加载后可能比实时观测少算失败 attempt；插件在 step 中途加载时，该 step 完成前悬停不会包含前半段，完成后会由已加载消息补齐。
- 插件在内存中最多保留 32 个会话的统计（LRU 淘汰）；更早的会话切回来后需从已加载消息重新补齐。
- 缓存命中率依赖服务端上报的会话累计 token；模型或平台不返回 cache 字段时该段不显示。
- 只作用于 OpenCode Desktop；TUI 不加载 GUI 部分。
- GUI 插件 API 目前是实验性的（`gui-experimental`），插件按 Desktop `2.2.5` 的 API 开发（依赖声明 `^2.2.5`），OpenCode 大版本升级后可能需要适配。
- 远程 server 场景下，客户端与服务器时钟偏差会影响实时估算（最终值不受影响）。

## License

MIT
