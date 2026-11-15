#!/usr/bin/env node
/**
 * Build-Runner MCP server.
 *
 * Speaks the Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0
 * on stdin/stdout. Implemented without an SDK so the package has zero runtime
 * dependencies — it must start instantly and never fail because a transitive
 * dependency was missing on the host.
 *
 * stdout carries protocol traffic ONLY. All diagnostics go to stderr.
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand, getRunStatus, cancelRun, diagnose } from './runner.js'
import { createClient } from './github.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))

const SERVER_INFO = { name: 'build-runner', version: pkg.version }
const PROTOCOL_VERSION = '2024-11-05'

function log(...args) {
  process.stderr.write(`[build-runner] ${args.join(' ')}\n`)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'run',
    description:
      '在云端 GitHub Actions 上执行一条命令，并把 stdout/stderr 和真实退出码原样返回。' +
      '用于本机没有构建环境（无 JDK/Android SDK/Xcode/特定运行时）时做自检：' +
      '它检出指定仓库的指定分支，在那里跑你的命令，效果等同于本地有环境。' +
      '默认等待执行完成并返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: '目标仓库，owner/name 或完整 GitHub URL。AI 工作区所在仓库。',
        },
        ref: {
          type: 'string',
          description: '分支、标签或完整 commit SHA。不填用仓库默认分支。',
        },
        command: {
          type: 'string',
          description:
            '要执行的命令，可多行。例如 "pnpm install && pnpm build" 或 "gradle assembleDebug"。',
        },
        shell: {
          type: 'string',
          enum: ['bash', 'pwsh', 'python'],
          description: '解释器，默认 bash。Windows 目标用 pwsh，脚本用 python。',
        },
        runner: {
          type: 'string',
          description:
            'runner 标签，默认 ubuntu-latest。可选 windows-latest、macos-latest、macos-14 等。',
        },
        setup: {
          type: 'string',
          description: '主命令前执行的准备命令（装依赖等），失败即终止。',
        },
        timeoutMinutes: {
          type: 'number',
          description: '单条命令的硬超时（分钟），默认 30，上限 120。',
        },
        artifactPaths: {
          type: 'string',
          description: '需要作为产物上传的路径，逗号或换行分隔。构建产物、测试报告放这里。',
        },
        fetchDepth: {
          type: 'number',
          description: 'git 抓取深度，默认 1（快）；需要 git 历史时设 0。',
        },
        cache: {
          type: 'string',
          enum: ['auto', 'none'],
          description: '依赖缓存，默认 auto（自动识别 pnpm/npm/gradle/cargo 等）。',
        },
        wait: {
          type: 'boolean',
          description: '是否等待执行完成，默认 true。长构建可设 false 先拿 runId 再轮询。',
        },
        maxWaitMs: {
          type: 'number',
          description: '最长等待毫秒数，默认 30 分钟。超时不取消任务。',
        },
        maxOutputChars: {
          type: 'number',
          description: '返回输出截断长度，默认 24000 字符。',
        },
      },
      required: ['repo', 'command'],
    },
  },
  {
    name: 'status',
    description: '查询某次云端运行的当前状态；已完成则直接返回完整输出和退出码。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'run 的 id（run 工具或上一次 status 返回的 runId）' },
        maxOutputChars: { type: 'number', description: '返回输出截断长度' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'cancel',
    description: '取消一次正在运行的云端任务，停止继续消耗 Actions 时间。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: '要取消的 run id' } },
      required: ['runId'],
    },
  },
  {
    name: 'doctor',
    description:
      '自检 Build-Runner 是否可用：token、构建器仓库、workflow 状态、Actions 是否正常。' +
      '派发后拿不到运行时先跑这个。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function invoke(toolName, args = {}) {
  switch (toolName) {
    case 'run': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await runCommand(client, {
        repo: args.repo,
        ref: args.ref,
        command: args.command,
        shell: args.shell,
        runner: args.runner,
        setup: args.setup,
        timeoutMinutes: args.timeoutMinutes,
        artifactPaths: args.artifactPaths,
        fetchDepth: args.fetchDepth,
        cache: args.cache,
        wait: args.wait !== false,
        maxWaitMs: args.maxWaitMs,
        maxOutputChars: args.maxOutputChars,
      })
    }
    case 'status': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await getRunStatus(client, {
        runId: args.runId,
        maxOutputChars: args.maxOutputChars,
      })
    }
    case 'cancel': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await cancelRun(client, { runId: args.runId })
    }
    case 'doctor':
      return await diagnose({})
    default:
      throw new Error(`未知工具：${toolName}`)
  }
}

/** Render a result as the text an AI can act on without a second lookup. */
function render(value) {
  if (value && typeof value === 'object' && 'conclusion' in value && 'output' in value) {
    const lines = []
    const verdict =
      value.succeeded === true
        ? '✅ 成功'
        : value.conclusion === 'cancelled'
          ? '⛔ 已取消'
          : value.conclusion
            ? `❌ 失败（${value.conclusion}）`
            : '⏳ 未完成'
    lines.push(`${verdict}  exit=${value.exitCode ?? 'n/a'}  ${value.durationSeconds ?? '?'}s`)
    lines.push(`仓库 ${value.repo ?? '?'} @ ${value.ref ?? '?'}${value.revision ? ` (${value.revision})` : ''}`)
    if (value.runUrl) lines.push(`运行 ${value.runUrl}`)
    lines.push('')
    lines.push('----- 输出 -----')
    lines.push(value.output && value.output.length > 0 ? value.output : '（无输出）')
    if (value.outputTruncated) {
      lines.push('')
      lines.push('（输出已截断，完整日志见上面的运行链接）')
    }
    if (value.failureHints?.length) {
      lines.push('')
      lines.push('----- 失败线索 -----')
      for (const hint of value.failureHints) lines.push(hint)
    }
    if (value.artifacts?.length) {
      lines.push('')
      lines.push('----- 产物 -----')
      for (const item of value.artifacts) lines.push(`${item.name} (${item.sizeBytes} B)`)
    }
    if (value.note) {
      lines.push('')
      lines.push(value.note)
    }
    return lines.join('\n')
  }
  return JSON.stringify(value, null, 2)
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized')
    return
  }

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, { tools: TOOLS })

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (!TOOLS.some(tool => tool.name === name)) {
        return replyError(id, -32602, `未知工具：${name}`)
      }
      try {
        const value = await invoke(name, args)
        return reply(id, {
          content: [{ type: 'text', text: render(value) }],
          // Structured copy so programmatic callers do not have to parse prose.
          structuredContent: value,
          isError: false,
        })
      } catch (error) {
        // A tool failure is a normal result with isError, not a protocol error:
        // the AI must see the message and be able to retry.
        return reply(id, {
          content: [{ type: 'text', text: `build-runner 执行失败：${error.message}` }],
          isError: true,
        })
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] })
    case 'prompts/list':
      return reply(id, { prompts: [] })

    default:
      return replyError(id, -32601, `不支持的方法：${method}`)
  }
}

function main() {
  log(`starting v${SERVER_INFO.version}`)
  if (!process.env.BUILD_RUNNER_TOKEN) {
    log('WARNING: BUILD_RUNNER_TOKEN 未设置，所有调用都会失败')
  } else {
    log(`token loaded (${process.env.BUILD_RUNNER_TOKEN.length} chars)`)
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  rl.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      log('无法解析的输入行，已忽略')
      return
    }
    handle(message).catch(error => {
      log(`处理 ${message?.method ?? '?'} 时异常：${error.stack ?? error.message}`)
      if (message?.id !== undefined && message?.id !== null) {
        replyError(message.id, -32603, error.message)
      }
    })
  })

  rl.on('close', () => {
    log('stdin closed, exiting')
    process.exit(0)
  })
}

main()
