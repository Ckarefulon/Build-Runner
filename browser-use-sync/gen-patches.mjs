// 生成 pnpm 补丁：以「name 行 + description 行」为上下文，把 engines.dsh 插在 name 之后。
// hunk 行数按统一 diff 规范精确计算，避免 pnpm 的 "hunk header integrity check" 失败。
import fs from 'node:fs'
import path from 'node:path'

const RANGE = '>=0.2.1-rc.1 <0.3.0-0'
const PROFILE = process.argv[2]
const PATCH_DIR = process.argv[3]

const TARGETS = [
  '@deepseek-ai/dsh-browser-use',
  '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp',
  '@deepseek-ai/dsh-experimental-browser-use-runtime',
]

fs.mkdirSync(PATCH_DIR, { recursive: true })

for (const name of TARGETS) {
  const file = path.join(PROFILE, 'node_modules', ...name.split('/'), 'package.json')
  if (!fs.existsSync(file)) throw new Error('missing package: ' + file)

  const raw = fs.readFileSync(file, 'utf8')
  JSON.parse(raw)
  const lines = raw.split(/\r?\n/)

  if (lines[0] !== '{') throw new Error(`${name}: 第一行不是 '{'`)
  const nameIdx = lines.findIndex((line) => /^\s*"name":\s*"@deepseek-ai\//.test(line))
  if (nameIdx !== 1) throw new Error(`${name}: name 行在第 ${nameIdx + 1} 行，补丁假定为第 2 行`)
  const descIdx = 2
  if (!/^\s*"description":/.test(lines[descIdx])) {
    throw new Error(`${name}: 第 3 行不是 description，无法作为稳定上下文`)
  }

  const nameLine = lines[nameIdx]
  const descLine = lines[descIdx]
  const insert = `  "engines": { "dsh": "${RANGE}" },`

  // 统一 diff：每个上下文行都必须以单个空格开头（包括第 1 行的 `{`），
  // 新增行以 '+' 开头。行数必须与 hunk 头完全一致，否则 pnpm 报
  // "hunk header integrity check failed"。
  const body = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1,3 +1,4 @@',
    ' ' + lines[0],
    ' ' + nameLine,
    '+' + insert,
    ' ' + descLine,
    '',
  ].join('\n')

  const patchFile = path.join(PATCH_DIR, `${name.split('/').pop()}-engines.patch`)
  fs.writeFileSync(patchFile, body, 'utf8')
  console.log(`wrote ${path.basename(patchFile)} (${name}@${JSON.parse(raw).version})`)
  console.log('--- patch body ---')
  console.log(body)
}
