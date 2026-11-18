/**
 * The resident loop, run inside the job.
 *
 * Kept as a Node script (not inline bash) because the loop has to parse JSON,
 * execute commands and post results — all things bash does badly. It is embedded
 * in the runner checkout, so it travels with the workspace patch machinery.
 *
 * Protocol (all on ONE issue):
 *   caller  -> comment starting with `BR-CMD:<id>` + a fenced code block
 *   runner  -> comment starting with `BR-RESULT:<id>` + a ```json block
 *
 * Why an issue rather than committing files: comments are append-only, so the
 * caller and the runner never fight over the same ref, and nothing lands in the
 * repository's git history.
 */
import { execFile } from 'node:child_process'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

const TOKEN = process.env.GH_TOKEN
const REPO = process.env.SESSION_REPO
const ISSUE = process.env.SESSION_ISSUE
const SHELL = process.env.SESSION_SHELL ?? 'bash'
const IDLE_LIMIT = Number(process.env.SESSION_IDLE_SECONDS ?? 900)
const POLL = Number(process.env.SESSION_POLL_SECONDS ?? 3)

const API = `https://api.github.com/repos/${REPO}`

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'build-runner-session',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`)
  }
  return response.status === 204 ? null : response.json()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Comments are append-only; ids make re-delivery harmless. */
async function listComments() {
  const comments = await api('GET', `/issues/${ISSUE}/comments?per_page=100`)
  return Array.isArray(comments) ? comments : []
}

function parseCommand(body) {
  const first = (body.split('\n', 1)[0] ?? '').trim()
  if (!first.startsWith('BR-CMD:')) return null
  const id = first.slice('BR-CMD:'.length).trim()
  const fence = body.match(/```[a-z]*\n([\s\S]*?)```/)
  if (!id || !fence) return null
  return { id, command: fence[1].replace(/\n$/, '') }
}

async function postResult(id, payload) {
  const json = JSON.stringify(payload, null, 2)
  const body = `BR-RESULT:${id}\n\`\`\`json\n${json}\n\`\`\``
  await api('POST', `/issues/${ISSUE}/comments`, { body })
}

async function execute(command) {
  const started = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'br-session-'))
  const ext = SHELL === 'pwsh' || SHELL === 'powershell' ? 'ps1' : SHELL === 'python' ? 'py' : 'sh'
  const script = join(dir, `cmd.${ext}`)
  await writeFile(script, `${command}\n`, 'utf8')

  const argv =
    ext === 'ps1' ? ['pwsh', ['-NoProfile', '-File', script]]
    : ext === 'py' ? ['python3', [script]]
    : ['bash', [script]]

  try {
    const { stdout, stderr } = await run(argv[0], argv[1], {
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Dorg.gradle.caching=true` },
    })
    return {
      exitCode: 0,
      durationSeconds: (Date.now() - started) / 1000,
      output: `${stdout}\n${stderr}`.trim().slice(-120000),
    }
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      durationSeconds: (Date.now() - started) / 1000,
      output: `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim().slice(-120000),
    }
  }
}

async function main() {
  console.log(`session loop: issue=${ISSUE} repo=${REPO} shell=${SHELL}`)
  const handled = new Set()
  let idle = 0

  while (idle < IDLE_LIMIT / POLL) {
    let comments
    try {
      comments = await listComments()
    } catch (error) {
      console.log(`list failed: ${error.message}`)
      await sleep(POLL * 1000)
      continue
    }

    const pending = []
    for (const comment of comments) {
      const parsed = parseCommand(comment.body ?? '')
      if (!parsed || handled.has(parsed.id)) continue
      handled.add(parsed.id)
      pending.push(parsed)
    }

    if (pending.length === 0) {
      idle += 1
      await sleep(POLL * 1000)
      continue
    }
    idle = 0

    for (const item of pending) {
      console.log(`\n===== 执行 ${item.id} =====`)
      console.log(item.command.split('\n').slice(0, 20).join('\n'))
      const result = await execute(item.command)
      console.log(`----- 退出码 ${result.exitCode}，${result.durationSeconds.toFixed(1)}s -----`)
      console.log(result.output.slice(-2000))
      try {
        await postResult(item.id, result)
        console.log(`结果已回写 ${item.id}`)
      } catch (error) {
        console.log(`回写失败：${error.message}`)
      }
    }
  }

  console.log('空闲超时，会话结束')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
