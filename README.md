<img src="https://raw.githubusercontent.com/blinkspark/opencode-tps-plugin/main/assets/icon.svg" width="88" height="88" alt="TPS meter icon" align="right" />

# @blinkspark/opencode-tps-plugin

在 OpenCode Desktop 的**会话标题栏**显示 tokens per second。

- 生成中：`~41 tok/s`，按最近 2 秒的流式增量估算；字符/ token 比例会从上一个完成的 step 自适应学习（中英文、代码混排都能跟得上）。
- 每步结束：改用服务端上报的真实 token 数计算该步生成速度，排除首 token 等待时间，并**一直保留**到下一次生成，颜色变淡。
- 悬停：显示该步的 token 数与生成耗时（`1234 tok · 27.3s`）。
- 标题栏空间不足时自动切换紧凑格式（`41 t/s`）。

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
| `countReasoning` | `true` | 是否把 reasoning tokens 计入速度与总量；关闭时 reasoning 流式增量也会被忽略 |

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
src/gui/badge.tsx    TPS 状态机与徽标组件
src/gui/badge.css    徽标样式
dist/gui-experimental.cjs  构建产物（GUI 部分必须为单个 CJS 文件）
```

## 计算方式

| 阶段 | 数据来源 | 显示 |
| --- | --- | --- |
| 生成中 | `session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta` 的字符数，2 秒滑动窗口 | 估算值，带 `~` |
| 每步结束 | `session.step.ended.data.tokens`，耗时取首个 delta 到最后一个 delta（排除首 token 等待） | 精确值 |
| 空闲 | 保留上一步结果 | 淡显 |

隐藏 reasoning 的模型（有 reasoning token 但没有 reasoning 流式事件）会回退为整个请求耗时，避免速度虚高。

## 已知限制

- 实时值是估算，最终以服务端 token 统计为准。
- 只作用于 OpenCode Desktop；TUI 不加载 GUI 部分。
- GUI 插件 API 目前是实验性的（`gui-experimental`），OpenCode 大版本升级后可能需要适配。
- 远程 server 场景下，客户端与服务器时钟偏差会影响实时估算（最终值不受影响）。

## License

MIT
