# Build-Runner

把 **GitHub Actions 当作云端构建机**：AI 指定「某个仓库 + 某个分支 + 一条命令」，
在云端检出该仓库、执行命令，并把 **stdout/stderr 与真实退出码**原样取回。

存在的理由很简单：AI 在本地改代码，但本机往往**没有构建环境**（没 JDK、没 Android SDK、
没 Xcode、没那个特定的运行时）。缺少环境时，AI 只能"猜这段代码应该能过"，无法自检。
Build-Runner 补上这个空缺 —— 让云端构建达到 **"和本地有环境一样"** 的效果。

```
AI  ──MCP──▶  build-runner (本地 stdio)  ──REST──▶  GitHub Actions
                  ▲                                      │
                  └────────  stdout/stderr/exit code ─────┘
```

## 核心设计：中央引擎

命令跑在本仓库的 workflow 里，它 **checkout 你的目标仓库**再执行。

这意味着 **目标仓库零改动** —— 不需要给它加任何 workflow 文件。
随便哪个仓库（哪怕是别人的、私有的）都能立刻用。

## 安装

```bash
# 1. 克隆（或本工作区里的 build-runner/ 目录）
# 2. 无需 npm install：运行时零依赖，只要 Node >= 20
node --version
```

需要三样东西：

| 项 | 说明 |
|---|---|
| `BUILD_RUNNER_TOKEN` | GitHub token，需 `repo` + `workflow` 权限 |
| 构建器仓库 | 默认 `Ckarefulon/Build-Runner`，用 `BUILD_RUNNER_REPO` 覆盖 |
| `CHECKOUT_TOKEN` secret | 已在构建器仓库配好；用于读取私有目标仓库 |

> 本机处于 HTTPS 检查型代理环境，Node 必须带 `--use-system-ca`，否则 TLS 校验失败。

## 注册到 DSH

```bash
BUILD_RUNNER_TOKEN=$(gh auth token) node --use-system-ca tools/register-dsh.mjs
```

这会在 `~/.dsh/profiles/desktop/cordis.patch.yml` 写入一行 MCP 服务器，
重启 DSH 后即可用 `mcp__build-runner__*` 工具。

## 工具

| 工具 | 作用 |
|---|---|
| `run` | 在云端执行命令并返回输出与退出码（默认等待完成） |
| `status` | 查询某次运行；已完成则直接返回完整结果 |
| `cancel` | 取消运行，停止消耗 Actions 时间 |
| `doctor` | 自检 token / 仓库 / workflow / Actions 是否正常 |
| `prepare_workspace` | 把本地未提交改动发布到构建分支（`dryRun` 可先看会传什么） |
| `workspace_status` | 看构建分支当前指向哪个 commit |
| `workspace_reset` | 把构建分支重置回基准分支，清历史 |

## 快照模式：不提交也能云端构建

给 `run` 传 `workspaceDir` 即可：**本地改完不用 commit、不用 push**，云端直接构建。

```jsonc
{
  "repo": "owner/name",
  "ref": "main",                    // 本地改动基于哪个分支
  "workspaceDir": "C:/path/to/repo", // 本地 git 工作区
  "command": "gradle assembleDebug"
}
```

### 为什么它不慢

关键点是：**内容本来就在 GitHub 上，不需要从本地重传一遍。**

```
本地 git status  →  只有 3 个文件变了
      ↓  只上传这 3 个 blob
GitHub 用 base_tree 把其余 4000 个文件在服务端拼进来
      ↓
在目标仓库的 build-runner 分支上生成 commit（parent = 真实基准 commit）
      ↓
云端 checkout 这个分支 → 构建
```

所以仓库有 5000 个文件、改了 3 个，就只传 3 个文件的字节。
实测：19 处改动 → 119 KiB，而不是整个仓库。

### 为什么它可信

新 commit 的 **parent 是真实的基准 commit**，不是凭空造的孤立提交。
所以 `git describe`、`git rev-list --count`、由提交数推导 versionCode 的项目，
行为与真提交后**完全一致**。用 tar 包上传做不到这一点。

实测输出（`tools/snapshot-proof.mjs`）：

```
--- parent linkage ---
a2950a2  ← 快照 commit
84ff97e  ← 父提交，就是 main 的 HEAD
--- log ---
a2950a2 build-runner: workspace snapshot
84ff97e build-runner: publish: src/runner.js
6228515 build-runner: publish: tools/_proof.mjs
```

### 边界

- **只有 git 能看见的文件会被上传**。`.gitignore` 排除的内容（`node_modules/`、
  构建产物、`.env`）永远不会离开本机 —— 这是刻意的防泄漏设计。
- **改动的文件在目标仓库里会以 `build-runner` 分支长期存在**。它不碰你的日常分支，
  但会在仓库里多出一个分支。用 `workspace_reset` 可以随时清回基准。
- **结果带 `mode: snapshot` 标记**。它是「预检」，不等同于已推送代码的构建 ——
  这个区别对 AI 判断该不该相信结论很重要。
- 快照模式默认拉**完整历史**（`fetch_depth: 0`），比普通模式慢几秒，换来版本号正确。


### `run` 的关键参数

```jsonc
{
  "repo": "owner/name",          // 必填，或完整 GitHub URL
  "ref": "main",                 // 分支/标签/commit SHA，默认仓库默认分支
  "command": "pnpm build",       // 必填，可多行
  "shell": "bash",               // bash | pwsh | python
  "runner": "ubuntu-latest",     // windows-latest / macos-latest / macos-14 …
  "setup": "pnpm install",       // 主命令前的准备步骤，失败即终止
  "timeoutMinutes": 30,          // 单命令硬超时
  "artifactPaths": "app/build/outputs/apk/**",  // 作为产物上传
  "wait": true,                  // false 则先拿 runId 再轮询
  "maxWaitMs": 1800000
}
```

## 它如何保证"和本地一样"

1. **真实退出码**：命令失败就是失败，不会被吞掉。`exit 42` 会返回 `exitCode: 42`。
2. **完整输出**：stdout 与 stderr 合并回传；超长时保留**头 + 尾**（错误通常在尾部）。
3. **精确的版本**：返回实际检出的 commit SHA，证明跑的是哪一份代码。
4. **失败线索**：自动从日志里摘出 `ERROR:`、`npm ERR!`、`Traceback` 等关键行。
5. **快速失败**：分支名写错在 1.5 秒内报错并提示默认分支，不会浪费 runner 时间。
6. **依赖缓存**：自动识别 pnpm/npm/yarn/gradle/maven/cargo/pip/go 并复用缓存。
7. **自动装 pnpm**：hosted runner 默认没有 pnpm，用 corepack 自动启用。

## 验证

```bash
# 解析器回归测试（不需要网络）
node --test test/logs.test.js

# 端到端：真实跑 2 次 Actions
BUILD_RUNNER_TOKEN=$(gh auth token) node --use-system-ca tools/smoke.mjs

# 跨仓库：验证目标仓库无需任何 workflow
BUILD_RUNNER_TOKEN=$(gh auth token) node --use-system-ca tools/cross-repo.mjs owner/repo branch

# 像 DSH 一样走 MCP 协议调用
BUILD_RUNNER_TOKEN=$(gh auth token) node --use-system-ca tools/mcp-client.mjs run @args.json
```

## 已知限制

- **私有目标仓库**依赖构建器仓库的 `CHECKOUT_TOKEN` secret；换账号或换仓库需同步更新。
- **不在 git 里的本地改动不会上传**。云端只能看到已推送的内容 ——
  这是刻意的：让"云端通过"和"提交的代码"严格对应。
- **冷启动约 25~50 秒**（排队 + 检出）。适合验证构建/测试，不适合毫秒级命令。
- Actions 免费额度按仓库计；本机 runner 仓库是 **public**，因此分钟数免费。

## 结构

```
.github/workflows/run.yml   # 中央引擎：checkout 目标仓库并执行命令
src/github.js               # GitHub REST 客户端
src/logs.js                 # 日志解析（剥离回显脚本/时间戳/ANSI）
src/runner.js               # 派发、定位运行、轮询、收集结果
src/server.js               # MCP stdio 服务器（零依赖手写 JSON-RPC）
tools/                      # publish / smoke / cross-repo / mcp-client / register-dsh
test/logs.test.js           # 解析器回归测试
```
