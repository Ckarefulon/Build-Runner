import { publishWorkspace, inspectBuildBranch } from '../src/snapshot.js'
import { runCommand } from '../src/runner.js'
import { createClient } from '../src/github.js'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = `SNAPSHOT-PROOF-${Date.now().toString(36)}`
const dir = process.cwd()
const repo = 'Ckarefulon/Build-Runner'
const targetFile = 'PROOF.txt'
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

console.log(`marker: ${MARKER}\n`)

// Edit a tracked file (.gitignore exists) and add an untracked one. Neither is
// committed -- that is the entire premise being tested.
const backup = readFileSync(join(dir, '.gitignore'), 'utf8')
writeFileSync(join(dir, '.gitignore'), `${backup}# ${MARKER}\n`)
writeFileSync(join(dir, targetFile), `${MARKER}\n`)

let ok = false
try {
  const status = readFileSync(join(dir, '.gitignore'), 'utf8').includes(MARKER)
  console.log(`local .gitignore edited (not committed): ${status}`)

  console.log('\n=== publish snapshot ===')
  const published = await publishWorkspace(client, { dir, repo, baseRef: 'main', branch: 'build-runner' })
  console.log(
    `changed=${published.changed} uploaded=${(published.uploadedBytes / 1024).toFixed(1)}KiB ` +
      `sha=${published.sha.slice(0, 7)} branch=${published.branch}`
  )
  console.log(`summary=${JSON.stringify(published.summary)}`)

  const branch = await inspectBuildBranch(client, { repo, branch: 'build-runner' })
  console.log(`build branch -> ${branch.sha.slice(0, 7)} "${branch.message}"`)

  console.log('\n=== build from the snapshot branch ===')
  const result = await runCommand(client, {
    repo,
    ref: branch.sha,
    command: [
      'echo "--- does the UNCOMMITTED edit exist in the cloud? ---"',
      `if grep -q '${MARKER}' .gitignore; then echo "EDIT-VISIBLE"; else echo "EDIT-MISSING"; fi`,
      `if [ -f ${targetFile} ]; then echo "NEWFILE-VISIBLE"; else echo "NEWFILE-MISSING"; fi`,
      'echo "--- history: the snapshot sits on the real base commit ---"',
      'git log --oneline -3',
      'echo "--- commit count (proves real parents, not a tarball) ---"',
      'git rev-list --count HEAD',
    ].join('\n'),
    wait: true,
    maxWaitMs: 8 * 60 * 1000,
    verifyBranch: false,
  })

  console.log(`exit=${result.exitCode} conclusion=${result.conclusion}\n`)
  console.log(result.output)

  const countSection = result.output.split('--- commit count (proves real parents, not a tarball) ---')[1] ?? ''
  const commitCount = Number((countSection.match(/\d+/) ?? ['0'])[0])

  const checks = [
    ['未提交的修改出现在云端', result.output.includes('EDIT-VISIBLE')],
    ['未跟踪的新文件出现在云端', result.output.includes('NEWFILE-VISIBLE')],
    ['云端看不到旧内容', !result.output.includes('EDIT-MISSING')],
    ['构建成功', result.exitCode === 0],
    // A tarball or shallow import would make this 1. Real parents make it > 1.
    [`历史是完整的（rev-list=${commitCount} > 1）`, commitCount > 1],
  ]
  console.log('\n=== verdict ===')
  ok = true
  for (const [name, passed] of checks) {
    if (!passed) ok = false
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
} finally {
  writeFileSync(join(dir, '.gitignore'), backup)
  if (existsSync(join(dir, targetFile))) rmSync(join(dir, targetFile))
  console.log('\nworking tree restored')
}

console.log(ok ? '\nSNAPSHOT PROOF PASS' : '\nSNAPSHOT PROOF FAIL')
process.exit(ok ? 0 : 1)
