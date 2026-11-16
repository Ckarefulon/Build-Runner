// Replay a DSH session surface and validate OpenAI-style tool-call/result pairing:
// every assistant message containing tool-call blocks must be followed immediately
// (in surface order) by tool/result nodes for each call id, with no other node in between.
// usage: node session-pairing.mjs <file.zstd> [fromSeq] [toSeq]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, fromS, toS] = process.argv.slice(2)
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
const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try { events.push(JSON.parse(line)) } catch {}
}
events.sort((a, b) => a.seq - b.seq)
const bySeq = new Map(events.map(e => [e.seq, e]))

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
let surface = []
for (const ev of events) {
  const op = ev.data?.surfaceOp
  if (op && op !== 'append') {
    const si = surface.indexOf(op.startSeq)
    const ei = surface.indexOf(op.endSeq)
    if (si === -1 || ei === -1) { surface.push(ev.seq); continue }
    surface = [...surface.slice(0, si), ev.seq, ...surface.slice(ei + 1)]
    continue
  }
  if (SURFACE.has(ev.type)) surface.push(ev.seq)
}

const from = Number(fromS ?? 0), to = Number(toS ?? Infinity)
let violations = 0
for (let i = 0; i < surface.length; i++) {
  const ev = bySeq.get(surface[i])
  if (!ev || ev.type !== 'assistant/message') continue
  const calls = (ev.data?.message?.content ?? []).filter(b => b.type === 'tool-call')
  if (calls.length === 0) continue
  const ids = new Set(calls.map(c => c.id))
  const answered = new Set()
  let j = i + 1
  let bad = null
  for (; j < surface.length && answered.size < ids.size; j++) {
    const nx = bySeq.get(surface[j])
    if (!nx) continue
    if (nx.type === 'tool/result') {
      const cid = nx.data?.toolCallId ?? nx.data?.message?.toolCallId
      if (ids.has(cid)) answered.add(cid)
      else { bad = `tool/result for unknown id ${cid}`; break }
      continue
    }
    bad = `${nx.type}${nx.data?.source?.kind ? ' src=' + nx.data.source.kind : ''}${nx.data?.source?.form ? '/' + nx.data.source.form : ''}`
    break
  }
  if (answered.size < ids.size || bad) {
    violations++
    const seqInRange = surface[i] >= from && surface[i] <= to
    console.log(`${seqInRange ? '>>>' : '   '} seq=${surface[i]} assistant has ${calls.length} tool-call(s) [${[...ids].join(', ')}]`)
    console.log(`      answered=${answered.size}/${ids.size}  interposed=${bad ?? '(none)'}`)
    if (bad) {
      console.log(`      next surface nodes: ${surface.slice(i + 1, i + 6).map(s => `${s}:${bySeq.get(s)?.type}`).join(' | ')}`)
    }
  }
}
console.log(`\nsurface nodes=${surface.length}  pairing violations=${violations}`)
