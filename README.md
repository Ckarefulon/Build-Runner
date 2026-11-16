# Build-Runner

**云端构建引擎。** 把 GitHub Actions 当作构建机：检出你指定的仓库、执行命令、
把结果交回调用方。

```
                          ┌─────────────────────────┐
   AI / 任何 HTTP 客户端 ──▶│  Ckarefulon/Build-Runner │──▶ GitHub Actions
                          │   （本仓库＝云端引擎）    │      checkout 目标仓库
                          └─────────────────────────┘      跑命令，回传结果
```

> **这是服务端。** 面向 AI 的 MCP 客户端在另一个仓库：
> [Ckarefulon/Build-Runner-MCP](https://github.com/Ckarefulon/Build-Runner-MCP)。
> 一般你只需要装那个；本仓库只是它背后跑命令的地方。

---

## 两个仓库的分工

| 仓库 | 角色 | 装在哪 | 内容 |
|---|---|---|---|
| **Build-Runner**（本仓库） | 云端引擎 | 放在 GitHub 上，什么都不用装 | 两个 workflow |
| [Build-Runner-MCP](https://github.com/Ckarefulon/Build-Runner-MCP) | MCP 客户端 | 你的本机 | 8 个 MCP 工具、编排逻辑 |

引擎负责「跑」，客户端负责「说」。分开的好处是：换引擎不用改客户端，
换宿主（Claude Desktop / Cursor / 别的）也不用碰引擎。

---

## 本仓库包含什么

```
.github/workflows/run.yml       # 执行引擎：checkout 目标仓库并跑命令
.github/workflows/release.yml   # 出包引擎：构建 → 打包 → 提交 → 发 Release
LICENSE
```

就这些。没有依赖、没有构建步骤、不需要安装——它只是一段在 GitHub 上运行的 YAML。

---

## 核心设计：中央引擎

命令跑在**本仓库**的 workflow 里，它 `checkout 你指定的目标仓库` 再执行。

这意味着 **目标仓库零改动**：不需要给它加任何 workflow 文件。
任何仓库（别人的、私有的）都能立刻用。

对比另一种做法——往每个目标仓库里装一个 workflow——本设计的代价是
命令运行在引擎仓库的资源与权限下；收益是零侵入。

---

## 部署

本仓库已经是一个可用的引擎。要用成你自己的：

```bash
git clone https://github.com/Ckarefulon/Build-Runner.git
cd Build-Runner
git remote set-url origin git@github.com:<你的账号>/Build-Runner.git
git push -u origin main
```

然后在 **Settings → Secrets** 里配置：

| Secret | 用途 | 必需 |
|---|---|---|
| `CHECKOUT_TOKEN` | 读取**私有**目标仓库 | 私有目标仓库必需；public 可省 |

`CHECKOUT_TOKEN` 需要一个能读目标仓库的 token（classic PAT 的 `repo` 权限即可）。

---

## 两个 workflow

### `run.yml` — 执行

| 输入 | 说明 |
|---|---|
| `repo` | 目标仓库 `owner/name`，留空表示本引擎仓库 |
| `ref` | 分支 / 标签 / commit SHA |
| `command` | 要执行的命令（走环境变量传入，不插值进 YAML） |
| `shell` | `bash` / `pwsh` / `python` |
| `runner` | `ubuntu-latest` / `windows-latest` / `macos-latest` … |
| `setup` | 主命令前的准备命令，失败即终止 |
| `artifact_paths` | 需要作为产物上传的路径 |
| `cache` | `auto` / `none`，自动识别 pnpm/npm/gradle/cargo/pip/go |

输出的关键约定：

- 真实输出包在 `--- BUILD-RUNNER-OUTPUT-BEGIN ---` 与 `--- BUILD-RUNNER-OUTPUT-END ---` 之间
- 退出码打印为 `BUILD-RUNNER-EXIT-CODE=<n>`
- 结束时有 `BUILD-RUNNER-REPORT-V1` 块，包含实际检出的 commit SHA

这样调用方可以从日志里精确剥离出「命令自己打印的内容」，
而不是把 GitHub 的步骤回显混进结果。

### `release.yml` — 出包

构建 → 打包（zip + SHA256）→ 提交到目标仓库 `builds` 分支根目录 →
在本引擎仓库发 GitHub Release 并附资产。

**打包在 runner 上完成**，产物不需要下载到调用方再上传。

---

## 性能：一次构建的时间花在哪

用真实 Gradle 项目实测（骨架项目 + 5 个依赖，ubuntu-latest）：

| 阶段 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| Environment 工具探测 | **29s** | **5s** | 原来对 21 个工具跑 `--version`，现在只探测命令里真正用到的 |
| 缓存下载 + 解包 | 16s（601 MB） | **3s**（137 MB） | 只缓存 `modules-2` / `transforms` / `wrapper`，不再是整个 `~/.gradle/caches` |
| 实际执行命令 | 10s | 10s | 构建本身 |
| **AI 端到端等待** | **96.6s** | **45.7s** | ↓ **53%** |

启示：**瓶颈往往不在构建，而在为构建做准备的那些步骤。**
一个只为打印版本号的探测步骤，曾比实际构建慢 3 倍。

> 工具的版本探测不再全量输出。需要看环境时，在命令里直接跑 `java -version` 即可，
> 或把想探测的工具名写进命令文本 —— 探测只针对命令里出现的工具。

---

## 设计取舍

这些都是踩过坑之后定的，不是随手写的：

- **命令走 `env` 传入，不插值进 `run:`** —— 否则引号、heredoc、`$` 会被 YAML 吃掉
- **探测型步骤显式 `set +e; set +o pipefail`** —— GitHub 给 bash 步骤注入 `-e -o pipefail`，
  任何 `tool --version | head -1` 在工具缺失时会让整个步骤失败
- **自动启用 corepack** —— hosted runner 默认没有 pnpm，而 AI 最常发的就是 `pnpm build`
- **依赖自动缓存** —— 否则每次调用都要冷装依赖，云端体验会明显差于本地
- **快照模式签出分支名而非 SHA** —— `actions/checkout` 收到 SHA 时即使
  `fetch-depth: 0` 也只取单个 commit，历史会变孤儿，`git describe` 就错了

---

## 验证

引擎本身没有测试套件（它就是 YAML）。验证靠客户端仓库里的端到端脚本：

```bash
git clone https://github.com/Ckarefulon/Build-Runner-MCP.git
cd Build-Runner-MCP
npm test
node tools/smoke.mjs
```

---

## License

MIT
