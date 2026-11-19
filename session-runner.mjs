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
import { execFile, spawn } from 'node:child_process'
import { writeFile, mkdtemp, readFile } from 'node:fs/promises'
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

/**
 * Environment for every command and for the screenshot helper.
 *
 * The emulator is installed and started by an earlier workflow step using full
 * paths, so `adb` is NOT on the default PATH here — the first screenshot attempt
 * failed with "bash: adb: command not found". Pinning the SDK dirs makes both
 * `adb` and the Gradle tooling reachable from any command the caller sends.
 */
const ANDROID_HOME = process.env.ANDROID_HOME || '/usr/local/lib/android/sdk'
const ANDROID_BIN = [
  `${ANDROID_HOME}/platform-tools`,
  `${ANDROID_HOME}/emulator`,
  `${ANDROID_HOME}/cmdline-tools/latest/bin`,
].join(':')

const CHILD_ENV = {
  ...process.env,
  ANDROID_HOME,
  ANDROID_SDK_ROOT: ANDROID_HOME,
  PATH: `${ANDROID_BIN}:${process.env.PATH ?? ''}`,
  GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Dorg.gradle.caching=true`,
}

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
  const inner = fence[1].replace(/\n$/, '')

  // Two shapes accepted, for backwards compatibility:
  //   raw command text            (the original form)
  //   {"command": "...", "artifactPaths": "..."}   (richer form)
  if (inner.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(inner)
      if (typeof parsed.command === 'string') {
        return { id, command: parsed.command, artifactPaths: parsed.artifactPaths ?? '' }
      }
    } catch {
      /* fall through to raw */
    }
  }
  return { id, command: inner, artifactPaths: '' }
}

/**
 * Upload build outputs as release assets.
 *
 * A debug APK is tens of MB. Committing it to a branch would bloat the
 * repository permanently, and `actions/upload-artifact` needs an authenticated
 * caller to download. Release assets avoid both problems: no git history, and a
 * plain download URL.
 *
 * One rolling tag is reused so sessions do not litter the releases page.
 */
async function uploadArtifacts(rawPaths, id) {
  const paths = String(rawPaths)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (paths.length === 0) return []

  const tag = 'br-session-artifacts'
  let release = null
  try {
    release = await api('GET', `/releases/tags/${tag}`)
  } catch {
    try {
      release = await api('POST', '/releases', {
        tag_name: tag,
        name: 'build-runner session artifacts',
        body: 'Session build outputs. Safe to delete; new uploads recreate them.',
        prerelease: true,
      })
    } catch (error) {
      console.log(`创建 release 失败：${error.message}`)
      return []
    }
  }

  const uploads = []
  for (const pattern of paths) {
    let files = []
    try {
      const { stdout } = await run('bash', ['-c', `ls -1 ${pattern} 2>/dev/null || true`], {
        env: CHILD_ENV,
        encoding: 'utf8',
      })
      files = stdout.split('\n').map(f => f.trim()).filter(Boolean)
    } catch {
      files = []
    }
    for (const file of files.slice(0, 10)) {
      try {
        const name = `${id}-${file.split('/').pop()}`
        const buffer = await readFile(file)
        // Asset upload is a different host from the REST API.
        const url = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/octet-stream',
            'User-Agent': 'build-runner-session',
          },
          body: buffer,
        })
        if (!response.ok) {
          console.log(`上传 ${file} 失败：${response.status}`)
          continue
        }
        const asset = await response.json()
        uploads.push({
          file,
          name,
          bytes: buffer.length,
          url: asset.browser_download_url,
        })
        console.log(`已上传资产 ${name} (${buffer.length} 字节)`)
      } catch (error) {
        console.log(`上传 ${file} 出错：${error.message}`)
      }
    }
  }
  return uploads
}

/**
 * Screenshot requests arrive as a command whose first token is a sentinel, so no
 * separate channel is needed. The PNG is returned base64 in the result comment:
 * a UI screenshot is typically 15-80 KB, which comfortably fits an issue comment
 * (65,536 char body limit ~ 48 KB of bytes), and it avoids a second round trip
 * through a branch or artifact.
 */
const SHOT_SENTINEL = 'BR-SCREENSHOT'

/** `execFile` has no stdin option, so pipe bytes through `spawn` directly. */
function runWithStdin(shellCommand, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', shellCommand], {
      env: CHILD_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`退出码 ${code}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    child.stdin.on('error', () => {
      /* the child may exit before reading everything; the close handler decides */
    })
    child.stdin.end(input)
  })
}

async function captureScreenshot() {
  try {
    // `exec-out` avoids the CRLF mangling that `adb shell` adds on Windows hosts.
    const { stdout } = await run('bash', ['-c', 'adb exec-out screencap -p'], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
      env: CHILD_ENV,
    })
    const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
    if (png.length < 100 || png[0] !== 0x89 || png[1] !== 0x50) {
      return { exitCode: 1, output: '截图数据不是有效 PNG（模拟器可能未就绪）', image: null }
    }
    const size = await run('bash', ['-c', 'adb shell wm size'], { encoding: 'utf8', env: CHILD_ENV })

    // A full 1080x2400 PNG measured 1.37 MB — too heavy to put in a model's
    // context on every look. Downscale to half resolution when ImageMagick is
    // available; UI problems an agent cares about (clipped text, wrong colours,
    // missing cards) survive that just fine.
    let payload = png
    try {
      const shrunk = await runWithStdin('convert - -resize 50% png:-', png)
      if (shrunk.length > 100 && shrunk[0] === 0x89) payload = shrunk
    } catch {
      // keep the original
    }

    // A 1080x2400 screenshot is routinely 100-300 KB. Base64 would blow past the
    // 65,536-character issue-comment limit, so the PNG goes to a branch in this
    // repo and only its path travels in the comment. (The first attempt inlined
    // it and the write silently failed, which is why no result appeared at all.)
    const path = `.build-runner/sessions/shot-${Date.now()}.png`
    let imagePath = null
    try {
      await api('PUT', `/contents/${path}`, {
        message: `screenshot ${path}`,
        content: payload.toString('base64'),
        branch: process.env.SESSION_BRANCH || 'main',
      })
      imagePath = path
    } catch (error) {
      console.log(`上传截图失败：${error.message}`)
    }

    return {
      exitCode: imagePath ? 0 : 1,
      durationSeconds: 0,
      output:
        `截图 ${payload.length} 字节（原始 ${png.length}）；${size.stdout.trim()}` +
        (imagePath ? `；已上传 ${imagePath}` : '；上传失败，无法回传图片'),
      image: imagePath ? { path: imagePath, bytes: payload.length, repo: REPO } : null,
    }
  } catch (error) {
    return { exitCode: 1, output: `截图失败：${error.message}`, image: null }
  }
}

/** Wrap the payload in a comment the caller can parse. */
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
      env: CHILD_ENV,
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
      const isShot = item.command.trim().startsWith(SHOT_SENTINEL)
      console.log(`\n===== ${isShot ? '截图' : '执行'} ${item.id} =====`)
      if (!isShot) console.log(item.command.split('\n').slice(0, 20).join('\n'))

      const result = isShot ? await captureScreenshot() : await execute(item.command)
      console.log(`----- 退出码 ${result.exitCode} -----`)
      console.log(String(result.output ?? '').slice(-2000))

      // Collect declared outputs even when the command failed: a partial package
      // is often exactly what the caller needs to diagnose.
      if (item.artifactPaths) {
        const artifacts = await uploadArtifacts(item.artifactPaths, item.id)
        if (artifacts.length > 0) result.artifacts = artifacts
        console.log(`产物：${artifacts.length} 个`)
      }

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
