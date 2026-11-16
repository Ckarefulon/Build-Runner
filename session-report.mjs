// Full report on a session: type histogram, surface, pairing audit, and every
// smart-compaction / compaction event in order.
// usage: node session-report.mjs <session.v4.jsonl[.zstd]>
import { loadEvents, buildSurface, auditPairing, describeEvent } from './session-load.mjs'

const [file] = process.argv.slice(2)
const events = loadEvents(file)
console.log(`file: ${file}`)
console.log(`events: ${events.length}  seq range: ${events[0]?.seq}..${events.at(-1)?.seq}`)

const counts = new Map()
for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
console.log('\n-- event types --')
for (const [t, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(c).padStart(6), t)

const { surface, bySeq, replaceLog } = buildSurface(events)
console.log(`\n-- surface (${surface.length} nodes) --`)
for (const seq of surface) console.log('  ' + describeEvent(bySeq.get(seq)))

const { violations, pending } = auditPairing(surface, bySeq)
console.log(`\n-- pairing --`)
console.log(`violations=${violations.length}  in-flight=${pending.length}`)
for (const v of violations) {
  console.log(`  VIOLATION at seq ${v.at}: answered=${v.answered}/${v.total} interposed=${v.interposed}`)
  const i = surface.indexOf(v.at)
  for (const s of surface.slice(Math.max(0, i - 2), i + 6)) console.log('     ' + describeEvent(bySeq.get(s)))
}
console.log(`replace ops: ${replaceLog.length}`)
for (const r of replaceLog) console.log(`  seq ${r.at} replace ${r.startSeq}..${r.endSeq} (idx ${r.si}..${r.ei})`)

console.log('\n-- compaction / notice events in order --')
for (const e of events) {
  const isCompaction = e.type.startsWith('compaction/')
  const isNotice = e.data?.source?.kind === 'smart-compaction'
  const isErr = e.type === 'assistant/attempt' && (e.data?.error || e.data?.finishReason === 'error')
  if (isCompaction || isNotice || isErr || e.type === 'turn/end' || e.type === 'request/header') {
    let extra = ''
    if (e.type === 'compaction/start' || e.type === 'compaction/end') {
      extra = JSON.stringify(e.data).slice(0, 200)
    } else if (e.type === 'compaction/summary') {
      extra = `provider=${e.data?.provider} model=${e.data?.model} shadowed=${e.data?.shadowedSeqs?.length} tokens=${e.data?.shadowedTokenCount}`
    } else if (isNotice) {
      const c = e.data?.content
      extra = (Array.isArray(c) ? c.map(x => x.text ?? '').join('') : String(c ?? '')).replace(/\s+/g, ' ').slice(0, 90)
    } else if (e.type === 'assistant/attempt') {
      extra = JSON.stringify(e.data?.error ?? e.data).slice(0, 240)
    } else if (e.type === 'turn/end') {
      extra = JSON.stringify(e.data).slice(0, 160)
    } else if (e.type === 'request/header') {
      extra = `reason=${e.data?.reason}`
    }
    console.log(`  seq ${String(e.seq).padStart(5)} ${e.type.padEnd(20)} surfaceOp=${e.surfaceOp ?? '-'} ${extra}`)
  }
}
