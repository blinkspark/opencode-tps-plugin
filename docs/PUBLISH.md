# 发布流程

本文记录 `@blinkspark/opencode-tps-plugin` 发布到 npm 的完整步骤。发布不可逆：**同一个版本号一旦发布成功就不能覆盖**，改代码后必须升版本。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| npm 账号 | `blinkspark`，拥有 `@blinkspark` scope（用户名即 scope，无需建 organization） |
| 发布源 | `https://registry.npmjs.org/`（已写入 `package.json` 的 `publishConfig`） |
| 可见性 | public（`publishConfig.access`） |
| 工作区 | 干净的 git 工作区，`npm run typecheck` / `npm run build` 通过 |

本机日常 `npm install` 走的是淘宝镜像，**发布必须走官方源**。`publishConfig` 只影响发布，不影响日常安装，无需切换 `~/.npmrc`。

## 1. 发布前检查

```bash
cd /e/dev/tps-plugin

git status                     # 应为 clean
npm run typecheck
npm run build
npm pack --dry-run             # 检查发布内容
```

`npm pack --dry-run` 预期包含：

```
LICENSE
README.md
dist/gui-experimental.cjs
package.json
src/gui.tsx
src/gui/badge.css
src/gui/badge.tsx
src/index.ts
```

不应出现 `node_modules/`、`package-lock.json`、`*.tgz`。

## 2. 登录官方 registry

npm 的登录凭证按 registry 存储，**必须显式指定官方源**：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/   # 应输出 blinkspark
```

如果 `whoami` 不是 `blinkspark`，先 `npm logout --registry=https://registry.npmjs.org/` 再重新登录。

## 3. 处理 2FA（首次发布会遇到）

账号开启 2FA 后，直接 `npm publish` 会返回：

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@blinkspark%2fopencode-tps-plugin
npm error Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

这不是包名或权限问题，是缺少一次性验证码。两种处理方式：

### 方式 A：发布时带 OTP

打开验证器 App，取 6 位动态码后立即执行（验证码约 30 秒过期）：

```bash
npm publish --otp=123456
```

### 方式 B：创建可绕过 2FA 的 Granular Token

1. 打开 <https://www.npmjs.com/settings/blinkspark/tokens>
2. **Generate New Token → Granular Access Token**
3. 配置：
   - Permissions: **Read and write**
   - Packages: **All packages**（或限定 `@blinkspark/*`）
   - 勾选 **Bypass two-factor authentication**
4. 复制 token（`npm_...`），在本机配置：

```bash
npm config set //registry.npmjs.org/:_authToken=npm_你的token
```

之后 `npm publish` 不再需要 OTP。

> token 等同账号写权限：不要提交到仓库、不要贴到聊天或日志里。CI 中用 `NPM_TOKEN` secret + `.npmrc` 的 `${NPM_TOKEN}` 引用。

## 4. 发布

```bash
npm publish
```

`prepublishOnly` 会自动执行：

```
npm run build && npm run typecheck
```

`publishConfig` 自动确保：

- 发布到 `https://registry.npmjs.org/`
- `access: public`

成功输出类似：

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
+ @blinkspark/opencode-tps-plugin@0.1.0
```

## 5. 发布后验证

```bash
npm view @blinkspark/opencode-tps-plugin version --registry=https://registry.npmjs.org/
```

安装到 OpenCode：

```bash
# 先移除全局配置里的本地路径条目，避免同一个插件加载两份
# ~/.config/opencode/opencode.jsonc 中删除 "E:/dev/tps-plugin"
opencode plugin add @blinkspark/opencode-tps-plugin
```

检查插件状态（`features` 应包含 `server` 与 `gui`）：

```bash
opencode api plugin.list
opencode api plugin.gui --param id=blinkspark-tps-meter
```

然后重启 OpenCode Desktop，确认：

- Settings → Extensions → Plugins 中出现 `blinkspark-tps-meter`
- 会话标题栏出现 `tok/s`
- 生成结束后数值保留并变淡

打 tag：

```bash
git tag v0.1.0
git push --tags
```

## 6. 版本迭代

npm 不允许覆盖已发布版本。每次发布前升版本：

```bash
npm version patch -m "chore: release %s"   # 或 minor / major
npm publish
git push --follow-tags
```

`npm version` 会自动修改 `package.json`、创建 release commit 和 git tag。

> 因为 `dist/` 也入库，发布前确认 `npm run build` 后 `git status` 干净；如果 `dist` 有变化，先提交再发布。

## 7. 常见错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `E403 ... Two-factor authentication` | 缺少 OTP | `npm publish --otp=xxxxxx`，或使用 bypass 2FA 的 granular token |
| `E403 ... not have permission` | 账号不属于 `@blinkspark` scope | 用 `blinkspark` 账号登录，或改用账号 scope |
| `E404 ... Not found` | 包名拼错，或 token 无该 scope 权限 | 检查包名与 token 权限 |
| `E409 ... cannot publish over` | 版本号已存在 | `npm version patch` 后重发 |
| `npm ERR! need auth` | 未登录，或登录到了淘宝镜像 | `npm login --registry=https://registry.npmjs.org/` |
| 发布成功但 `opencode plugin add` 找不到 | 镜像同步延迟 / 安装源不是官方 | 等待同步，或用 `@0.1.0` 指定版本重试 |
| 桌面端出现两个 TPS 徽标 | 本地路径与 npm 包同时配置 | 删除全局配置里的本地路径条目后重载 |

## 8. 安全检查

- `.npmrc`、`*.token`、`*.pem` 不得提交；当前仓库 `.gitignore` 已忽略 `node_modules/` 和 `*.log`。
- 发布前执行 `git diff --cached` 确认没有把 token 或本机绝对路径带进包。
- token 泄露时立即到 npmjs.com 撤销并重新生成。
