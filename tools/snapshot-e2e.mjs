#!/usr/bin/env node
/**
 * End-to-end proof of the workspace (uncommitted changes) mode.
 *
 * The claim being verified: a file edited locally and NEVER committed is what
 * the remote build actually compiles. Anything less than checking the file's
 * content inside the run would only prove that *something* was dispatched.
 *
 * Usage: BUILD_RUNNER_TOKEN=... node --use-system-ca tools/snapshot-e2e.mjs owner/repo branch
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runCommand } from '../src/runner.js'
import { createClient } from '../src/github.js'
import { publishWorkspace, inspectBuildBranch } from '../src/snapshot.js'

const repo = process.argv[2] ?? 'Ckarefulon/dsh-providers-hub'
const baseRef = process.argv[3] ?? 'master'
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

const MARKER = `SNAPSHOT-MARKER-${Date.now().toString(36)}`

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  console.log(`target ${repo}@${baseRef}\n`)

  // Build a throwaway clone so the test never touches a real working copy.
  // A clone of a large repo would be slow, so clone shallow.
  const dir = mkdtempSync(join(tmpdir(), 'br-snap-'))
  const cloneUrl = `https://github.com/${repo}.git`
  console.log(`cloning ${cloneUrl} (depth 1) ...`)

  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', baseRef, cloneUrl, dir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        // The snapshot path only needs the clone; local TLS to github is broken
        // on this machine, so hand git a token header instead of relying on the
        // credential helper.
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().slice(0, 300) : error.message
    console.log(`clone failed: ${detail}`)
    rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }

  let result
  try {
    console.log('clone ok')

    // The whole point: edit a tracked file and DO NOT COMMIT.
    const targetFile = existsSync(join(dir, 'SNAPSHOT_PROBE.txt'))
      ? 'SNAPSHOT_PROBE.txt'
      : 'README.md'
    const original = readFileSync(join(dir, targetFile), 'utf8')
    const dirty = `${MARKER}\n${original}`
    writeFileSync(join(dir, targetFile), dirty)
    writeFileSync(join(dir, 'snapshot-new-file.txt'), `${MARKER}-NEW\n`)

    const status = git(dir, ['status', '--porcelain=v1'])
    console.log(`\nlocal status (uncommitted):\n${status}`)
    console.log(`\nHEAD is still clean: ${git(dir, ['rev-parse', 'HEAD']).slice(0, 7)}`)

    console.log('\n=== publish snapshot (only the diff) ===')
    const published = await publishWorkspace(client, {
      dir,
      repo,
      baseRef,
      branch: 'build-runner',
      message: `snapshot e2e ${MARKER}`,
    })
    console.log(
      `changed=${published.changed} uploaded=${published.uploadedBytes}B sha=${published.sha?.slice(0, 7)} branch=${published.branch}`
    )
    console.log(`summary ${JSON.stringify(published.summary)}`)

    const branchInfo = await inspectBuildBranch(client, { repo, branch: 'build-runner' })
    console.log(`build branch now at ${String(branchInfo.sha).slice(0, 7)} (${branchInfo.message})`)

    console.log('\n=== run the build against the snapshot branch ===')
    result = await runCommand(client, {
      repo,
      ref: branchInfo.sha,
      command: [
        `echo "searching for marker ${MARKER}"`,
        `if grep -q '${MARKER}' ${targetFile}; then echo "FOUND-EDITED-CONTENT"; else echo "MISSING-EDITED-CONTENT"; fi`,
        `if [ -f snapshot-new-file.txt ]; then echo "FOUND-NEW-FILE"; cat snapshot-new-file.txt; else echo "MISSING-NEW-FILE"; fi`,
        'echo "--- parent of HEAD (proves real history) ---"',
        'git log --oneline -2 2>/dev/null || true',
      ].join('\n'),
      wait: true,
      maxWaitMs: 8 * 60 * 1000,
      verifyBranch: false,
    })

    console.log(`\nexit=${result.exitCode} conclusion=${result.conclusion}`)
    console.log('--- remote output ---')
    console.log(result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const checks = [
    ['快照包含未提交的修改', result.output.includes('FOUND-EDITED-CONTENT')],
    ['快照包含新增的未跟踪文件', result.output.includes('FOUND-NEW-FILE')],
    ['远端没有看到旧内容', !result.output.includes('MISSING-EDITED-CONTENT')],
    ['构建成功', result.exitCode === 0],
    ['历史父提交是真实基准', /build-runner: workspace snapshot|snapshot e2e/.test(result.output)],
  ]
  console.log('\n=== verdict ===')
  let ok = true
  for (const [name, passed] of checks) {
    if (!passed) ok = false
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
  console.log(ok ? '\nSNAPSHOT E2E PASS' : '\nSNAPSHOT E2E FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error(`failed: ${error.message}`)
  process.exit(1)
})
