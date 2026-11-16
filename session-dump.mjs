// Dump selected event types from a DSH session file, newest-last, with a short summary.
// usage: node session-dump.mjs <file.zstd> <typeSubstr> [maxEvents]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, typeSub, maxM] = process.argv.slice(2)
const maxEvents = Number(maxM ?? 40)
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let idx = 0
while ((idx = buf.indexOf(MAGIC, idx)) !== -1) { starts.push(idx); idx += 4 }
starts.push(buf.length)
const parts = []
for (let i = 0; i < starts.length - 1; i++) {
  try { parts.push(zstdDecompressSync(buf.subarray(starts[i], starts[i + 1]))) } catch {}
}
const text = Buffer.concat(parts).toString('utf8')
let n = 0
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (!ev.type || !ev.type.includes(typeSub)) continue
  n++
  if (n > maxEvents) { console.log('... (truncated)'); break }
  const d = ev.data ?? {}
  const brief = {}
  for (const k of ['turn', 'status', 'code', 'message', 'error', 'failure', 'provider', 'model', 'compactionId', 'shadowedRange', 'shadowedTokenCount', 'startSeq', 'endSeq', 'name', 'reason', 'maxTokens']) {
    if (d[k] !== undefined) brief[k] = d[k]
  }
  console.log(`#${n} seq=${ev.seq} ${ev.type} ${JSON.stringify(brief).slice(0, 700)}`)
}
console.error(`[${n} events matching "${typeSub}" in ${file}]`)
