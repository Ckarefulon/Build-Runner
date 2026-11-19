# 自托管 runner：真正意义上的「常开」

GitHub 托管的 runner **做不到常开**。这不是配置问题，是硬限制：

| 事实 | 后果 |
|---|---|
| 每个 job 上限 6 小时 | 会话必然过期 |
| 每次 job 都是全新 VM | 一切要重建 |
| 无法跨 job 保留进程 | 环境必然冷启动 |

所以「过很久之后仍然像常开」只有两条路：

## 方案 A：缓存预热（本次已实现）

把三样东西缓存起来，新 session 直接恢复：

| 缓存 | 省下的时间 |
|---|---|
| `~/.gradle/caches` | 依赖下载（首次几分钟） |
| Android SDK（emulator + system-image，4.2G） | 安装 37 秒 |
| AVD + 模拟器快照 | 开机 39 秒 → 几秒 |

**局限**：恢复 4.2G 缓存本身也要 20-40 秒，所以只能做到「30-60 秒内可用」，做不到「立刻可用」。

## 方案 B：自托管 runner（真正的常开）

在你的机器上装 runner，把 `runs-on` 改成 `self-hosted`：

```yaml
runs-on: self-hosted   # 而不是 ubuntu-latest
```

这样：

- **没有 6 小时限制**（job 可以跑几天）
- SDK、AVD、Gradle 依赖**永久留在磁盘**，一次装好不用再装
- 模拟器可以**预先启动并一直开着**
- Gradle daemon **一直在**，编译 1 秒级

代价：需要一台常开的机器。

### 最小部署

```bash
# 在目标机器上（Linux / macOS / Windows 均可）
mkdir actions-runner && cd actions-runner
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.320.0/actions-runner-linux-x64-2.320.0.tar.gz
tar xzf runner.tar.gz
./config.sh --url https://github.com/Ckarefulon/Build-Runner --token <RUNNER_TOKEN>
./run.sh   # 或 ./svc.sh install && ./svc.sh start 常驻
```

`RUNNER_TOKEN` 在仓库 Settings → Actions → Runners → New self-hosted runner 里拿（1 小时有效，仅用于注册）。

### 注册后需要改的地方

`session.yml` 的 `runs-on` 已经是 `${{ inputs.runner }}`，所以**不用改代码**，只要在调用时传：

```json
{ "repo": "...", "runner": "self-hosted" }
```

### 自托管时应该关掉的东西

- `actions/cache` 的三步（本地磁盘本来就是持久的，缓存反而拖慢）
- 模拟器快照保存（机器不重启，模拟器可以一直开着）

### 安全提醒

自托管 runner 会执行工作流里的任意命令，**不要给公开仓库用**（有人开 PR 就能在你机器上跑代码）。只在私有仓库、或只接受你自己触发的仓库上用。