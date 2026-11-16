// Counterfactual: replay the crashed session's surface with the plugin's
// offending notice (seq 998) removed, and re-check tool-call/result pairing.
// Proves the guard is SUFFICIENT, not merely necessary.
// usage: node simulate-fix.mjs <session.v4.jsonl.zstd> [dropSeq]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const drop = process.argv[3] ? Number(process.argv[3]) : null
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let i = 0
while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
starts.push(buf.length)
const parts = []
for (let k = 0; k < starts.length - 1; k++) {
  try { parts.push(zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]))) } catch {}
}
const events = []
for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
  if (!line.trim()) continue
  try { events.push(JSON.parse(line)) } catch {}
}
events.sort((a, b) => a.seq - b.seq)
const bySeq = new Map(events.map(e => [e.seq, e]))

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
function build(skip) {
  let surface = []
  for (const ev of events) {
    if (skip !== null && ev.seq === skip) continue
    const op = ev.surfaceOp
    if (op !== undefined && op !== 'append') {
      const si = surface.indexOf(op.startSeq), ei = surface.indexOf(op.endSeq)
      if (si === -1 || ei === -1) { surface.push(ev.seq); continue }
      surface = [...surface.slice(0, si), ev.seq, ...surface.slice(ei + 1)]
      continue
    }
    if (SURFACE.has(ev.type)) surface.push(ev.seq)
  }
  return surface
}
function pairing(surface) {
  const out = []
  for (let i = 0; i < surface.length; i++) {
    const ev = bySeq.get(surface[i])
    if (!ev || ev.type !== 'assistant/message') continue
    const calls = (ev.data?.message?.content ?? []).filter(b => b.type === 'tool-call')
    if (calls.length === 0) continue
    const ids = new Set(calls.map(c => c.id))
    const answered = new Set()
    let bad = null
    for (let j = i + 1; j < surface.length && answered.size < ids.size; j++) {
      const nx = bySeq.get(surface[j])
      if (!nx) continue
      if (nx.type === 'tool/result') {
        const cid = nx.data?.toolCallId ?? nx.data?.message?.toolCallId
        if (ids.has(cid)) answered.add(cid); else { bad = `${surface[j]} tool/result(unknown)`; break }
        continue
      }
      bad = `${surface[j]} ${nx.type}`
      break
    }
    if (answered.size < ids.size || bad) {
      out.push(`  seq ${surface[i]} assistant[tool-call] answered=${answered.size}/${ids.size} interposed=${bad ?? '(none)'}`)
    }
  }
  return out
}

for (const [label, skip] of [['AS-IS (with the notice)', null], [`WITH FIX (seq ${drop} suppressed)`, drop]]) {
  const surface = build(skip)
  const v = pairing(surface)
  console.log(`${label}: surface nodes=${surface.length} pairing violations=${v.length}`)
  for (const line of v) console.log(line)
}
