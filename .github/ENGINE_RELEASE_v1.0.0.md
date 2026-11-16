# Build-Runner Engine v1.0.0

**云端构建引擎。** 把 GitHub Actions 当作构建机：检出你指定的仓库、执行命令、交回结果。

本仓库只包含两个 workflow，没有依赖、无需安装——它只是一段在 GitHub 上运行的 YAML。

> 面向 AI 的 **MCP 客户端**已拆分到独立仓库：
> [Ckarefulon/Build-Runner-MCP](https://github.com/Ckarefulon/Build-Runner-MCP)
> 一般你只需要装那个；本仓库是它背后跑命令的地方。

---

## 为什么拆成两个仓库

| 仓库 | 角色 | 装在哪 |
|---|---|---|
| **Build-Runner**（本仓库） | 云端引擎 | 放在 GitHub 上，什么都不用装 |
| Build-Runner-MCP | MCP 客户端 | 你的本机 |

引擎负责「跑」，客户端负责「说」。换引擎不用改客户端，换宿主（Claude Desktop /
Cursor）也不用碰引擎。

---

## 本仓库内容

```
.github/workflows/run.yml       # 执行引擎：checkout 目标仓库并跑命令
.github/workflows/release.yml   # 出包引擎：构建 → 打包 → 提交 → 发 Release
```

### `run.yml` 的关键约定

- 真实输出包在 `--- BUILD-RUNNER-OUTPUT-BEGIN ---` / `--- BUILD-RUNNER-OUTPUT-END ---` 之间
- 退出码打印为 `BUILD-RUNNER-EXIT-CODE=<n>`
- 结束时有 `BUILD-RUNNER-REPORT-V1` 块，含实际检出的 commit SHA

这样调用方能从日志里精确剥离「命令自己打印的内容」，而不是把 GitHub 的步骤回显混进结果。

---

## 部署

```bash
git clone https://github.com/Ckarefulon/Build-Runner.git
cd Build-Runner
git remote set-url origin git@github.com:<你的账号>/Build-Runner.git
git push -u origin main
```

**Settings → Secrets** 里配置 `CHECKOUT_TOKEN`（只有私有目标仓库才需要）。

---

## 设计取舍

踩过坑之后定的：

- **命令走 `env` 传入，不插值进 `run:`** —— 否则引号、heredoc、`$` 会被 YAML 吃掉
- **探测型步骤显式 `set +e; set +o pipefail`** —— GitHub 给 bash 注入 `-e -o pipefail`，
  任何 `tool --version | head -1` 在工具缺失时会让整个步骤失败
- **自动启用 corepack** —— hosted runner 默认没有 pnpm，而 AI 最常发的就是 `pnpm build`
- **依赖自动缓存** —— 否则每次调用都冷装依赖，云端体验明显差于本地
- **快照模式签出分支名而非 SHA** —— `actions/checkout` 收到 SHA 时即使 `fetch-depth: 0`
  也只取单个 commit，历史变孤儿，`git describe` 就错了

**License**: MIT
