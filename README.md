# opencode-tps-plugin

在 OpenCode Desktop 的**会话标题栏**显示 tokens per second。

- 生成中：`~41 tok/s`，按最近 2 秒的流式增量估算；字符/ token 比例会从上一个完成的 step 自适应学习（中英文、代码混排都能跟得上）。
- 每步结束：改用服务端上报的真实 token 数计算该步平均速度，并**一直保留**到下一次生成，颜色变淡。
- 悬停：显示该步的 token 数与耗时（`1234 tok · 27.3s`）。
- 标题栏空间不足时自动切换紧凑格式（`41 t/s`）。

## 安装

插件目录：`E:\dev\tps-plugin`。

全局配置 `~/.config/opencode/opencode.jsonc` 已加入：

```jsonc
{
  "plugins": ["E:/dev/tps-plugin"],
}
```

OpenCode Desktop 只从全局 `opencode.json(c)` 加载 GUI 插件；本地目录会依次解析
`package.json` 的 `exports`（`"."` → 服务端部分，`"./gui-experimental"` → 窗口部分）。

## 配置项

需要改行为时，把条目换成对象形式：

```jsonc
{
  "plugins": [
    {
      "package": "E:/dev/tps-plugin",
      "options": {
        "countReasoning": true,
      },
    },
  ],
}
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `countReasoning` | `true` | 是否把 reasoning tokens 计入速度与总量 |

## 开发

需要 Node.js（本机在 fnm 下）与 npm：

```bash
npm install
npm run build      # 产出 dist/gui-experimental.cjs
npm run typecheck
npm run watch      # 监听构建，桌面端会热重载 GUI
```

## 结构

```
src/index.ts         服务端部分（Plugin.define id: tps，无逻辑）
src/gui.tsx          GUI 入口：注册样式与 session.header slot
src/gui/badge.tsx    TPS 状态机与徽标组件
src/gui/badge.css    徽标样式
dist/gui-experimental.cjs  构建产物（GUI 部分必须为单个 CJS 文件）
```

## 计算方式

| 阶段 | 数据来源 | 显示 |
| --- | --- | --- |
| 生成中 | `session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta` 的字符数，2 秒滑动窗口 | 估算值，带 `~` |
| 每步结束 | `session.step.ended.data.tokens` 与 `session.step.started.data.started` | 精确平均值 |
| 空闲 | 保留上一步结果 | 淡显 |

## 已知限制

- 实时值是估算，最终以服务端 token 统计为准。
- 只作用于 OpenCode Desktop；TUI 不加载 GUI 部分。
- GUI 插件 API 目前是实验性的（`gui-experimental`），OpenCode 大版本升级后可能需要适配。
