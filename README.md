# Build-Runner

**把 GitHub Actions 当作你的云端构建机。**

AI 指定「仓库 + 分支 + 命令」，Build-Runner 在云端检出那份代码、执行命令，
把 **stdout/stderr 和真实退出码原样返回**。

```
AI  ──MCP──▶  build-runner (本地 stdio)  ──REST──▶  GitHub Actions
                  ▲                                      │
                  └────────  stdout/stderr/exit code ─────┘
```

---

## 它解决什么问题

AI 在本地改代码，但你的机器往往**没有构建环境**：没 JDK、没 Android SDK、没 Xcode、
没那个特定版本的运行时。没有环境，AI 只能「猜这段代码应该能过」——这不是自检，是赌博。

Build-Runner 让 AI 把命令丢到云端跑，拿回真实结果。**效果等同于本地有环境。**

三个关键能力：

| 能力 | 说明 |
|---|---|
| **跑命令** | 任意仓库、任意分支，云端执行，返回真实输出与退出码 |
| **不提交也能构建** | 本地改完直接构建，只上传 diff，不用 commit / push |
| **出包** | 构建 → 打包 → 提交到仓库 → 发 GitHub Release，一条命令 |

---

## 核心设计：中央引擎

命令跑在**本仓库**的 workflow 里，它 `checkout 你指定的目标仓库` 再执行。

这意味着 **目标仓库零改动** —— 不需要给它加任何 workflow 文件。
随便哪个仓库（别人跑的、私有的）都能立刻用。

---

## 快速开始

### 1. 准备 token

需要一个 GitHub token，具备 `repo` + `workflow` 权限：

```bash
export BUILD_RUNNER_TOKEN=$(gh auth token)   # 已登录 gh 的话
```

### 2. 让构建器仓库能读取目标仓库

如果目标仓库是**私有**的，在构建器仓库里配置一个 secret：

```bash
gh secret set CHECKOUT_TOKEN --repo <你的账号>/Build-Runner
```

（public 目标仓库可跳过，会用默认 token）

### 3. 接入 MCP 客户端

运行时**零依赖**，只要 Node >= 20，无需 `npm install`。

```jsonc
{
  "mcpServers": {
    "build-runner": {
      "command": "node",
      "args": ["/绝对路径/Build-Runner/src/server.js"],
      "env": {
        "BUILD_RUNNER_TOKEN": "ghp_xxx",
        "BUILD_RUNNER_REPO": "你的账号/Build-Runner"
      }
    }
  }
}
```

不同客户端的配置文件位置不同：Claude Desktop 是 `claude_desktop_config.json`，
Cursor 是 `~/.cursor/mcp.json`，其他客户端大同小异。

### 4. 第一次调用

```
先调 doctor，确认 token / 仓库 / workflow 都正常
再调 run：{"repo": "你的账号/别的仓库", "command": "node -v && pnpm -v"}
```

---

## 工具一览

| 工具 | 用途 |
|---|---|
| `run` | 云端执行命令，返回输出与退出码 |
| `release` | 构建 → 打包 → 提交仓库根目录 → 发 GitHub Release |
| `prepare_workspace` | 把本地未提交改动发布到构建分支（`dryRun` 可先预览） |
| `workspace_status` | 查看构建分支当前指向 |
| `workspace_reset` | 重置构建分支，清历史 |
| `status` | 查询某次运行；已完成则直接返回结果 |
| `cancel` | 取消运行，停止消耗 Actions 分钟 |
| `doctor` | 自检配置是否可用 |

### `run` 参数

```jsonc
{
  "repo": "owner/name",          // 必填，也接受完整 GitHub URL
  "ref": "main",                 // 分支/标签/commit SHA，默认仓库默认分支
  "command": "pnpm build",       // 必填，可多行
  "shell": "bash",               // bash | pwsh | python
  "runner": "ubuntu-latest",     // windows-latest / macos-latest / macos-14 …
  "setup": "pnpm install",       // 主命令前的准备步骤，失败即终止
  "timeoutMinutes": 30,          // 单命令硬超时
  "artifactPaths": "dist/**",    // 作为产物上传
  "wait": true,                  // false 则先拿 runId 再轮询
  "maxWaitMs": 1800000
}
```

---

## 快照模式：不提交也能构建

给 `run` 传 `workspaceDir` 即可。**本地改完不用 commit、不用 push。**

```jsonc
{
  "repo": "owner/name",
  "ref": "main",                     // 本地改动基于哪个分支
  "workspaceDir": "/path/to/repo",   // 本地 git 工作区
  "command": "gradle assembleDebug"
}
```

### 为什么它不慢

**内容本来就在 GitHub 上，不需要从本地重传一遍。**

```
本地 git status  →  只有 3 个文件变了
      ↓  只上传这 3 个 blob
GitHub 用 base_tree 把其余 4000 个文件在服务端拼进来
      ↓
在目标仓库的 build-runner 分支上生成 commit（parent = 真实基准 commit）
      ↓
云端 checkout 这个分支 → 构建
```

仓库有 5000 个文件、改了 3 个，就只传 3 个文件的字节。
实测：19 处改动 → 119 KiB，而不是整个仓库。

### 为什么它可信

新 commit 的 **parent 是真实的基准 commit**，不是凭空造的孤立提交。
所以 `git describe`、`git rev-list --count`、由提交数推导 versionCode 的项目，
行为与真提交后**完全一致**。用 tar 包上传做不到这一点。

实测（`tools/snapshot-proof.mjs`）：

```
--- parent linkage ---
a2950a2  ← 快照 commit
84ff97e  ← 父提交，就是 main 的 HEAD
```

### 边界

- **只有 git 能看见的文件会被上传**。`.gitignore` 排除的内容（`node_modules/`、
  构建产物、`.env`）永远不会离开你的机器 —— 这是刻意的防泄漏设计。
- 会在目标仓库多出一个 `build-runner` 分支。它不碰你的日常分支，
  用 `workspace_reset` 可随时清回基准。
- 结果带 `mode: snapshot` 标记。它是**预检**，不等同于已推送代码的构建。
  这个区别对判断「该不该信这个结论」很重要。
- 默认拉完整历史（慢几秒），换来版本号正确。

---

## 出包（release）

```jsonc
{
  "repo": "owner/name",
  "ref": "main",
  "command": "gradle assembleDebug",           // 留空则直接打包已有文件
  "artifactPaths": "app/build/outputs/apk/**",  // 必填
  "packageName": "app-debug",
  "releaseTag": "app-debug-v1.2",               // 默认同包名
  "commitBranch": "builds"                       // 产物落到这个分支根目录
}
```

做三件事：

1. **云端构建并打包**（zip；无 zip 时退化为 tar.gz），算出 SHA256
2. **把包提交到目标仓库根目录**的 `builds` 分支
3. **在构建器仓库发 GitHub Release**，把包作为资产附上

### 为什么打包也在云端

产物已经在 runner 上了。先下载回本地再上传，等于把同样的字节搬两次——
这正是本工具要避免的，而且大于内存的包会直接失败。

### 刻意的取舍

- **包提交到独立的 `builds` 分支，不是你的工作分支。** 推工作分支会污染没人要求
  修改的分支，遇到分支保护还会直接失败。
- **构建失败就不会有包。** 打包步骤是 `if: success()`，避免半成品被当成品发出去。
- **同 tag 重发不报错**：已有 Release 就覆盖资产，方便重跑。
- **`artifactPaths` 匹配不到文件会直接失败**，而不是发空包。
- 只想发 Release、不提交到仓库：传 `commitToRepo: false`。

---

## 它如何保证「和本地一样」

1. **真实退出码** —— `exit 42` 就返回 `exitCode: 42`，不会被吞掉
2. **完整输出** —— stdout 与 stderr 合并回传；超长时保留**头 + 尾**（错误通常在尾部）
3. **精确版本** —— 返回实际检出的 commit SHA
4. **失败线索** —— 自动从日志里摘出 `ERROR:`、`npm ERR!`、`Traceback` 等关键行
5. **快速失败** —— 分支名写错 1.5 秒内报错并提示默认分支，不浪费 runner 时间
6. **依赖缓存** —— 自动识别 pnpm/npm/yarn/gradle/maven/cargo/pip/go
7. **自动装 pnpm** —— hosted runner 默认没有 pnpm，用 corepack 自动启用

---

## 验证

```bash
# 单元测试（不联网）
npm test

# 端到端：真实跑 2 次 Actions
BUILD_RUNNER_TOKEN=$(gh auth token) node tools/smoke.mjs

# 跨仓库：验证目标仓库无需任何 workflow
BUILD_RUNNER_TOKEN=$(gh auth token) node tools/cross-repo.mjs owner/repo main

# 快照模式：验证未提交改动真的被构建
SNAPSHOT_E2E_ALLOW_DIRTY=1 BUILD_RUNNER_TOKEN=$(gh auth token) node tools/snapshot-proof.mjs

# 像 MCP 客户端一样调用
BUILD_RUNNER_TOKEN=$(gh auth token) node tools/mcp-client.mjs list
```

`tools/publish.mjs` 用于把本仓库同步到 GitHub（走 Contents API，
适合 git 传输被代理阻断的网络环境）。

---

## 常见问题

**调 `run` 报「找不到分支」**
分支名校验在派发前完成，会提示该仓库的默认分支。确认 `ref` 拼写，或省略它用默认分支。

**派发了但拿不到运行结果**
先调 `doctor`。最常见原因是构建器仓库的 Actions 被禁用，或 workflow 文件不在默认分支上。

**私有仓库 checkout 失败（404）**
构建器仓库缺少 `CHECKOUT_TOKEN` secret，或该 token 没有目标仓库的读权限。

**命令报 `pnpm: command not found`**
已在 workflow 里用 corepack 自动启用；若仍失败，在 `setup` 里显式安装。

**输出被截断了**
默认返回 24000 字符（保留头尾）。调大 `maxOutputChars`，或点返回里的 run URL 看完整日志。

**Node 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**
你的网络有 HTTPS 检查型代理。用 `node --use-system-ca src/server.js` 启动
（在 MCP 配置的 `args` 里加 `--use-system-ca`）。

---

## 已知限制

- **冷启动 25~50 秒**（排队 + 检出）。适合验证构建/测试，不适合毫秒级命令。
- **私有目标仓库**依赖构建器仓库的 `CHECKOUT_TOKEN` secret，换账号需同步更新。
- **快照模式只上传 git 能看见的文件**。想构建被 `.gitignore` 排除的产物，请改用 `release`
  的 `artifactPaths`。
- **Actions 分钟数按仓库计**。public 仓库免费；private 仓库消耗额度。
- 命令的 stdout/stderr 会进入 Actions 日志，**不要在里面打印密钥**。

---

## 项目结构

```
.github/workflows/run.yml      # 中央引擎：checkout 目标仓库并执行命令
.github/workflows/release.yml  # 出包：构建 → 打包 → 提交根目录 → 发 Release
src/github.js                  # GitHub REST 客户端（含 Git Data / Trees API）
src/logs.js                    # 日志解析（剥离回显脚本/时间戳/ANSI）
src/runner.js                  # 派发、定位运行、轮询、收集结果
src/snapshot.js                # 快照：base_tree 增量提交
src/workspace.js               # 本地 diff 采集（git status -z）
src/release.js                 # 出包编排与结果解析
src/server.js                  # MCP stdio 服务器（零依赖手写 JSON-RPC）
tools/                         # 发布、冒烟、跨仓库、快照验证、MCP 客户端
test/                          # 回归测试
```

## License

MIT
