// Dump a seq range from a DSH session file with per-type field summaries.
// usage: node session-range.mjs <file.zstd> <fromSeq> <toSeq> [mode]
//   mode=types  (default) one line per event: seq, type, key fields
//   mode=json   full JSON for events whose type matches the 4th arg (regex)
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, fromS, toS, mode = 'types'] = process.argv.slice(2)
const from = Number(fromS), to = Number(toS)
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
const KEYS = ['turn', 'step', 'status', 'code', 'message', 'provider', 'model', 'maxTokens', 'contextWindow', 'compactionId', 'shadowedRange', 'shadowedTokenCount', 'name', 'reason', 'role', 'surfaceOp', 'kind', 'form']
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (typeof ev.seq !== 'number' || ev.seq < from || ev.seq > to) continue
  if (mode !== 'types' && mode !== 'json') {
    if (!new RegExp(mode).test(ev.type ?? '')) continue
    console.log(`===== seq=${ev.seq} ${ev.type} =====`)
    console.log(JSON.stringify(ev).slice(0, 6000))
    continue
  }
  const d = ev.data ?? {}
  const brief = {}
  for (const k of KEYS) if (d[k] !== undefined) brief[k] = typeof d[k] === 'string' ? d[k].slice(0, 160) : d[k]
  if (d.content !== undefined) brief.content = JSON.stringify(d.content).slice(0, 200)
  if (d.config !== undefined) brief.config = JSON.stringify(d.config).slice(0, 300)
  console.log(`seq=${ev.seq} ${ev.type} ${JSON.stringify(brief).slice(0, 900)}`)
}
