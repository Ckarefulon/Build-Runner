#!/usr/bin/env node
/**
 * Push the working tree to a GitHub repo through the Contents API.
 *
 * Why not `git push`: this machine sits behind an HTTPS-inspecting proxy whose
 * CA the git TLS backends do not trust (schannel: SEC_E_NO_CREDENTIALS,
 * openssl: unable to get local issuer certificate), while Node with
 * --use-system-ca reaches the API fine. The Contents API keeps the publish path
 * working without weakening any TLS verification.
 *
 * Usage: node tools/publish.mjs [--repo owner/name] [--branch main] [--message "..."]
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const API = 'https://api.github.com'
const ROOT = process.cwd()

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const REPO_SLUG = arg('repo', 'Ckarefulon/Build-Runner')
const BRANCH = arg('branch', 'main')
const MESSAGE = arg('message', 'build-runner: publish')

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (stats.isFile()) out.push(full)
  }
  return out
}

function token() {
  // Prefer the environment: under the DSH sandbox a Node child process cannot
  // capture another program's piped stdio (spawnSync EPERM), so shelling out to
  // `gh auth token` is not an option there.
  const fromEnv = process.env.BUILD_RUNNER_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

async function api(method, path, body, tok) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'build-runner-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let parsed = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: response.status, ok: response.ok, body: parsed }
}

async function main() {
  const tok = token()
  const files = walk(ROOT).map(full => ({
    full,
    rel: relative(ROOT, full).split(sep).join('/'),
  }))
  console.log(`publishing ${files.length} files to ${REPO_SLUG}@${BRANCH}`)

  // Make sure the branch exists before writing a single file.
  const branchCheck = await api('GET', `/repos/${REPO_SLUG}/git/ref/heads/${BRANCH}`, null, tok)
  if (!branchCheck.ok) {
    console.log('branch missing; creating the repository branch')
    const empty = await api(
      'PUT',
      `/repos/${REPO_SLUG}/contents/.build-runner-bootstrap`,
      {
        message: 'bootstrap',
        branch: BRANCH,
        content: Buffer.from(`build-runner ${new Date().toISOString()}\n`).toString('base64'),
      },
      tok
    )
    if (!empty.ok) throw new Error(`无法创建分支：${JSON.stringify(empty.body).slice(0, 300)}`)
    await api('DELETE', `/repos/${REPO_SLUG}/contents/.build-runner-bootstrap`, {
      message: 'bootstrap cleanup',
      branch: BRANCH,
      sha: empty.body.content.sha,
    }, tok)
  }

  let created = 0
  let updated = 0
  let skipped = 0

  for (const file of files) {
    const content = readFileSync(file.full)
    const b64 = content.toString('base64')
    const path = `/repos/${REPO_SLUG}/contents/${file.rel.split('/').map(encodeURIComponent).join('/')}`

    const existing = await api('GET', `${path}?ref=${encodeURIComponent(BRANCH)}`, null, tok)
    let sha
    if (existing.ok && existing.body && !Array.isArray(existing.body)) {
      // Contents API returns base64 with newlines; compare decoded bytes.
      const current = Buffer.from(existing.body.content ?? '', 'base64')
      if (current.equals(content)) {
        skipped += 1
        continue
      }
      sha = existing.body.sha
    }

    const result = await api('PUT', path, {
      message: `${MESSAGE}: ${file.rel}`,
      content: b64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }, tok)

    if (!result.ok) {
      throw new Error(`写入 ${file.rel} 失败（HTTP ${result.status}）：${JSON.stringify(result.body).slice(0, 300)}`)
    }
    if (sha) updated += 1
    else created += 1
    console.log(`  ${sha ? 'updated' : 'created'} ${file.rel}`)
  }

  const head = await api('GET', `/repos/${REPO_SLUG}/commits/${BRANCH}`, null, tok)
  console.log(`\ndone: ${created} created, ${updated} updated, ${skipped} unchanged`)
  console.log(`head: ${head.body?.sha ?? '?'} ${head.body?.commit?.message?.split('\n')[0] ?? ''}`)
  console.log(`url : https://github.com/${REPO_SLUG}/tree/${BRANCH}`)
}

main().catch(error => {
  console.error(`publish failed: ${error.message}`)
  process.exit(1)
})
