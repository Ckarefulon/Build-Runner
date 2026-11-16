// Counterfactual: replay a session's surface with one event suppressed and
// re-audit tool-call/result pairing. Works on .jsonl and .jsonl.zstd.
// usage: node counterfactual.mjs <session file> [dropSeq]
import { loadEvents, buildSurface, auditPairing, describeEvent } from './session-load.mjs'

const [file, dropS] = process.argv.slice(2)
const drop = dropS === undefined ? null : Number(dropS)
const events = loadEvents(file)

for (const [label, skip] of [['AS-IS', null], [`WITH seq ${drop} suppressed`, drop]]) {
  const { surface, bySeq } = buildSurface(events, skip)
  const { violations, pending } = auditPairing(surface, bySeq)
  console.log(`${label}: surface nodes=${surface.length} pairing violations=${violations.length} in-flight=${pending.length}`)
  for (const v of violations) {
    console.log(`   VIOLATION seq ${v.at} answered=${v.answered}/${v.total} interposed=${v.interposed}`)
    const i = surface.indexOf(v.at)
    for (const s of surface.slice(Math.max(0, i - 2), i + 5)) console.log('      ' + describeEvent(bySeq.get(s)))
  }
}
