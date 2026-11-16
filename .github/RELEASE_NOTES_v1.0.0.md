# Build-Runner v1.0.0

把 **GitHub Actions 当作云端构建机**：AI 指定「仓库 + 分支 + 命令」，
在云端执行并把 **stdout/stderr 与真实退出码原样返回**。

解决的问题：AI 在本地改代码，但你的机器往往没有构建环境（没 JDK、没 Android SDK、
没 Xcode）。没有环境，AI 只能「猜这段代码应该能过」——这不是自检，是赌博。
Build-Runner 让云端构建达到 **和本地有环境一样** 的效果。

---

## 核心设计：中央引擎

命令跑在 Build-Runner 自己的 workflow 里，它 `checkout 你指定的目标仓库` 再执行。

所以 **目标仓库零改动** —— 不需要给它加任何 workflow 文件，任何仓库（别人的、私有的）
都能立刻用。

```
AI  ──MCP──▶  build-runner (本地 stdio)  ──REST──▶  GitHub Actions
                  ▲                                      │
                  └────────  stdout/stderr/exit code ─────┘
```

---

## 八项能力

### 1. `run` —— 跑命令

```jsonc
{ "repo": "owner/name", "ref": "main", "command": "pnpm build" }
```

返回真实退出码与合并后的 stdout/stderr。`exit 42` 就返回 `exitCode: 42`，不会被吞掉。

### 2. `release` —— 出包

```jsonc
{
  "repo": "owner/name",
  "command": "gradle assembleDebug",
  "artifactPaths": "app/build/outputs/apk/**"
}
```

云端构建 → 打包（zip，含 SHA256）→ 提交到目标仓库 `builds` 分支根目录 →
在构建器仓库发 GitHub Release 并附资产。**打包在云端完成**，产物不需要下载回本机再上传。

### 3-5. 快照模式三件套 —— 不提交也能构建

```jsonc
{ "repo": "owner/name", "workspaceDir": "/path/to/repo", "command": "pnpm build" }
```

本地改完**不用 commit、不用 push**，云端直接构建。

- `run` + `workspaceDir`：发布本地改动并构建
- `prepare_workspace`：只发布不改构建（`dryRun` 可预览会传什么）
- `workspace_status` / `workspace_reset`：查看与清理构建分支

**为什么不慢**：内容本来就在 GitHub 上。本地 `git status` 找出改动的几个文件，只传这几个 blob，
其余由 GitHub 用 `base_tree` 在服务端拼接。实测 19 处改动只传 119 KiB。

**为什么可信**：新 commit 的 **parent 是真实的基准 commit**，所以 `git describe`、
`git rev-list --count`、由提交数推导 versionCode 的项目，行为与真提交后完全一致。
tar 包上传做不到这一点。

### 6-8. `status` / `cancel` / `doctor`

查询运行状态、取消运行（停止消耗 Actions 分钟）、自检配置。

---

## 安装

无需 `npm install`，运行时零依赖，只要 **Node >= 20**。

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

Token 需要 `repo` + `workflow` 权限（`gh auth token` 即可）。
私有目标仓库还需在构建器仓库配置 `CHECKOUT_TOKEN` secret。

---

## 交付质量

- **19 个回归测试**全过，覆盖日志解析（包括「不把回显的脚本当输出」这个致命陷阱）与
  `git status -z` 的编码/改名/中文路径处理
- 三个可复跑的端到端验证脚本：`tools/smoke.mjs`、`tools/cross-repo.mjs`、
  `tools/snapshot-proof.mjs`
- 实测：跨仓库在无 workflow 的仓库上执行成功、Android 环境探测返回 `openjdk 17` +
  `ANDROID_HOME`、构建失败时不产出空包

---

## 已知限制

- **冷启动 25~50 秒**（排队 + 检出），适合验证构建，不适合毫秒级命令
- 快照模式只上传 **git 能看见**的文件（`.gitignore` 排除的内容永不出本机）
- 快照结果是 **预检** 语义（带 `mode: snapshot` 标记），不等同于已推送代码的构建
- 命令输出会进入 Actions 日志，**不要在里面打印密钥**

---

## 完整文档

见 [README](https://github.com/Ckarefulon/Build-Runner#readme)。

**License**: MIT
