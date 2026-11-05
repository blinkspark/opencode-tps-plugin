<img src="https://raw.githubusercontent.com/blinkspark/opencode-tps-plugin/main/assets/icon.svg" width="88" height="88" alt="TPS meter icon" align="right" />

# @blinkspark/opencode-tps-plugin

在 OpenCode Desktop 的**会话标题栏**显示实时 / 上一轮 tokens per second、首 token 延迟和缓存命中率。

- 生成中：`~41 tok/s · 38 avg · TTFT 0.9s · cache 87%`
  - `~41 tok/s`：按最近 2 秒的流式增量估算；字符/token 比例会从上一个完成的 step 自适应学习（中英文、代码混排都能跟得上）。
  - `38 avg`：上一个 step 的平均速度，用服务端真实 token 数计算，排除首 token 等待；流式窗口不可信时会退回整步耗时并标 `~`。
  - `TTFT 0.9s`：首 token 延迟。等待首 token 时显示实时累加（`TTFT 1.2s…`）。
  - `cache 87%`：当前会话累计的输入缓存命中率。
- 每步结束：实时值消失，平均值更新为该步结果，并**一直保留**到下一次生成，颜色变淡。
- 悬停：每段都有明细（token 数、耗时、缓存 read / write / new）。
- 标题栏空间不足时自动切换紧凑格式：`~41 · 38 · 0.9s · 87%`。

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
| `countReasoning` | `true` | 是否把 reasoning tokens 计入 TPS 与总量；关闭时 reasoning 流式增量会被忽略，但 TTFT 仍把 reasoning delta 视作首个 token |

## 本地开发

把插件目录本身配置进 `opencode.jsonc` 即可，无需发布：

```jsonc
{
  "plugins": ["E:/dev/tps-plugin"],
}
```

需要 Node.js 与 npm：

```bash
npm install
npm run build      # 产出 dist/gui-experimental.cjs
npm run typecheck
npm run watch      # 监听构建，桌面端会热重载 GUI
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
src/gui/badge.tsx    TPS / TTFT / 缓存状态机与徽标组件
src/gui/badge.css    徽标样式
dist/gui-experimental.cjs  构建产物（GUI 部分必须为单个 CJS 文件）
```

## 计算方式

| 指标 | 数据来源 | 口径 |
| --- | --- | --- |
| 实时 TPS | `session.text.delta` / `session.reasoning.delta` 的字符数，2 秒滑动窗口 | 估算值，带 `~`；2 秒内没有新增量时隐藏，不显示 `~0` |
| 上一轮平均 | `session.step.ended.data.tokens` | `(output + reasoning) / 流式窗口`，尽量排除 TTFT |
| 首 token 延迟 | `session.step.started.data.started` → 第一个生成事件 | text / reasoning delta 或 `tool.input.started`；即使 `countReasoning: false` 也算 |
| 缓存命中率 | 会话累计 `tokens` | `cache.read / (input + cache.read + cache.write)` |

`tokens.input` 是非缓存输入，所以分母要把 `cache.read` 和 `cache.write` 加回来。缓存率是**会话累计**，切换会话会跟着变；首次请求通常是 0%。

平均值的流式窗口优先使用 `session.step.streamed`（stream 结束时刻），并覆盖 `session.tool.input.started` / `.ended`，因为工具参数的 token 也计入 `tokens.output`，但服务端不会发送 `tool.input.delta`。

服务端会把增量按约 100ms 合并后发布，且部分 provider 会整块 flush。如果观察窗口短于 500ms、有效 delta 少于 3 个，或模型隐藏了 reasoning，平均值会退回整步耗时（包含 TTFT），并在数字前加 `~`，避免出现几千 tok/s 的假值。TTFT 只能量到首个可见事件，隐藏 reasoning 时会标成 `~`。

## 已知限制

- 实时值是估算，最终以服务端 token 统计为准；2 秒窗口没有新增量时实时段会隐藏。
- 工具参数的 token 计入平均值分子，其生成时间按 `tool.input.started` / `.ended` 估算；服务端不提供更细的时序。
- 缓存命中率依赖服务端上报的会话累计 token；模型或平台不返回 cache 字段时该段不显示。
- 只作用于 OpenCode Desktop；TUI 不加载 GUI 部分。
- GUI 插件 API 目前是实验性的（`gui-experimental`），OpenCode 大版本升级后可能需要适配。
- 远程 server 场景下，客户端与服务器时钟偏差会影响实时估算（最终值不受影响）。

## License

MIT
