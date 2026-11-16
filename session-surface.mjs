// Replay a DSH session surface faithfully (surfaceOp is a TOP-LEVEL event
// property, not inside data) and report tool-call/result pairing violations.
// usage: node session-surface.mjs <file.zstd> [fromSeq] [toSeq]
//        node session-surface.mjs <file.zstd> pairing
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
const replaceLog = []
for (const ev of events) {
  const op = ev.surfaceOp
  if (op !== undefined && op !== 'append') {
    const si = surface.indexOf(op.startSeq)
    const ei = surface.indexOf(op.endSeq)
    replaceLog.push({ at: ev.seq, startSeq: op.startSeq, endSeq: op.endSeq, si, ei })
    if (si === -1 || ei === -1) { surface.push(ev.seq); continue }
    surface = [...surface.slice(0, si), ev.seq, ...surface.slice(ei + 1)]
    continue
  }
  if (SURFACE.has(ev.type)) surface.push(ev.seq)
}

function describe(seq) {
  const ev = bySeq.get(seq)
  if (!ev) return `${seq} <missing>`
  const d = ev.data ?? {}
  if (ev.type === 'assistant/message') {
    const blocks = d.message?.content ?? []
    return `${seq} assistant[${blocks.map(b => b.type === 'tool-call' ? `tool-call(${b.name})` : b.type).join(',')}]`
  }
  if (ev.type === 'tool/result') {
    const cid = d.toolCallId ?? d.message?.toolCallId
    return `${seq} tool/result(${cid})`
  }
  if (ev.type === 'user/message' || ev.type === 'system/message') {
    const content = d.content
    const txt = Array.isArray(content) ? content.map(c => c.text ?? '').join('') : String(content ?? '')
    return `${seq} ${ev.type}[src=${d.source?.kind ?? d.role ?? '?'}${d.source?.form ? '/' + d.source.form : ''}] "${txt.replace(/\s+/g, ' ').slice(0, 60)}"`
  }
  return `${seq} ${ev.type}`
}

if (fromS === 'pairing') {
  let violations = 0
  let pending = 0
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
        if (ids.has(cid)) answered.add(cid); else { bad = `tool/result(unknown ${cid})`; break }
        continue
      }
      bad = describe(surface[j])
      break
    }
    if (answered.size < ids.size || bad) {
      // A call that is still open at the very tail of the surface, with nothing
      // interposed, is simply in flight (the tool has not returned yet) — that
      // is normal for a live session and is NOT surface corruption. Only an
      // interposed non-result node, or a trailing unresolved call that has
      // other nodes after it, indicates a corrupt surface.
      const atTail = i === surface.length - 1
      if (atTail && bad === null) {
        pending++
        console.log(`PENDING (in flight, not corruption) at surface[${i}] ${describe(surface[i])} answered=${answered.size}/${ids.size}`)
        continue
      }
      violations++
      console.log(`VIOLATION at surface[${i}] ${describe(surface[i])}`)
      console.log(`   answered=${answered.size}/${ids.size} interposed=${bad ?? '(none)'}`)
      console.log(`   window: ${surface.slice(Math.max(0, i - 2), i + 5).map(describe).join('\n           ')}`)
    }
  }
  console.log(`\nsurface nodes=${surface.length}  pairing violations=${violations}  in-flight=${pending}`)
  console.log('replace ops:', JSON.stringify(replaceLog))
} else {
  const from = Number(fromS ?? 0), to = Number(toS ?? Infinity)
  console.log(`surface nodes: ${surface.length}`)
  for (const seq of surface) {
    if (seq < from || seq > to) continue
    console.log('  ' + describe(seq))
  }
}
