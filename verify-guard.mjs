// Verify the smart-compaction guard against the real crashed session:
// replay the surface, stop just before the plugin's notice was appended, and
// report what `canAppendToSurface` would have decided at that moment.
// usage: node verify-guard.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
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
const delta = ev => ev.type === 'assistant/message'
  ? (ev.data?.message?.content ?? []).filter(b => b.type === 'tool-call').length
  : ev.type === 'tool/result' ? -1 : 0

// Fold the surface exactly as the session does, and record the balance of the
// cut after the tail right before every event that would append.
let surface = []
let open = 0
const timeline = []
for (const ev of events) {
  const op = ev.surfaceOp
  if (op !== undefined && op !== 'append') {
    const si = surface.indexOf(op.startSeq), ei = surface.indexOf(op.endSeq)
    // A replace swaps the shadowed range in place; balance of the new tail is
    // recomputed by the core helper, so only log the op itself here.
    if (si !== -1 && ei !== -1) {
      surface = [...surface.slice(0, si), ev.seq, ...surface.slice(ei + 1)]
      open = 0
      for (const s of surface) open += delta(bySeq.get(s))
    }
    timeline.push({ seq: ev.seq, type: ev.type, op, balancedAfter: open === 0, tail: surface.at(-1) })
    continue
  }
  if (SURFACE.has(ev.type)) {
    open += delta(ev)
    surface.push(ev.seq)
  }
  timeline.push({ seq: ev.seq, type: ev.type, op: op ?? 'append', balancedAfter: open === 0, tail: surface.at(-1) })
}

// The plugin's own notice is the append that corrupted the surface.
const notices = events.filter(e => e.data?.source?.kind === 'smart-compaction')
console.log(`smart-compaction notice events: ${notices.map(e => e.seq).join(', ') || '(none)'}`)

for (const n of notices) {
  const before = timeline.filter(t => t.seq < n.seq)
  const at = before.at(-1)
  const tailEv = bySeq.get(at.tail)
  const tailDesc = tailEv?.type === 'assistant/message'
    ? `assistant[${(tailEv.data?.message?.content ?? []).map(b => b.type === 'tool-call' ? `tool-call(${b.name})` : b.type).join(',')}]`
    : `${tailEv?.type}`
  console.log(`\nnotice at seq ${n.seq}`)
  console.log(`  surface tail just before it: seq ${at.tail} = ${tailDesc}`)
  console.log(`  cut after tail balanced?     ${at.balancedAfter}`)
  console.log(`  => canAppendToSurface would return ${at.balancedAfter}`)
  console.log(`  => guard ${at.balancedAfter ? 'ALLOWS' : 'BLOCKS'} the append  ${at.balancedAfter ? '(would still corrupt!)' : '(bug prevented)'}`)
}

// Show the replace op that the checkpoint used, to confirm it lands early.
const replaces = events.filter(e => e.surfaceOp && e.surfaceOp !== 'append')
console.log(`\nreplace ops in this session: ${replaces.length}`)
for (const r of replaces.slice(0, 6)) {
  console.log(`  seq ${r.seq} ${r.type} replace ${r.surfaceOp.startSeq}..${r.surfaceOp.endSeq}`)
}
