// Unit-test the guard against the REAL tool-pairing implementation and the
// REAL surface of the failing session, reconstructed exactly as it was at the
// moment the notice was appended.
// usage: node test-guard.mjs <session.v4.jsonl>
import { loadEvents, buildSurface } from './session-load.mjs'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.mjs'

const [file] = process.argv.slice(2)
const events = loadEvents(file)
const bySeq = new Map(events.map(e => [e.seq, e]))

// The plugin appends its notice from inside compact_now's execute(). Find that
// notice and rebuild the surface from only the events that existed before it.
const notice = events.find(e => e.data?.source?.kind === 'smart-compaction')
if (!notice) { console.log('no smart-compaction notice in this session'); process.exit(0) }
console.log(`notice is at seq ${notice.seq}`)

const before = events.filter(e => e.seq < notice.seq)
const { surface } = buildSurface(before)
console.log(`surface just before the notice: [${surface.join(', ')}]`)
console.log(`tail = seq ${surface.at(-1)} (${bySeq.get(surface.at(-1))?.type})`)

const tailEvent = bySeq.get(surface.at(-1))
const calls = (tailEvent?.data?.message?.content ?? []).filter(b => b.type === 'tool-call')
console.log(`tail carries ${calls.length} tool-call(s): ${calls.map(c => c.name).join(', ')}`)

// A session whose surface is exactly that, resolving events against the log —
// the same shape @deepseek-ai/dsh-session presents to the plugin.
function makeSession(nodes) {
  return { surface: { nodes, replaceGeneration: 1 }, eventAt: seq => bySeq.get(seq) }
}

const s = makeSession(surface)
const after = toolPairingBalancedAfter(s, surface.at(-1))
const beforeTail = toolPairingBalancedBefore(s, surface.at(-1))

function canAppendToSurface(session) {
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  try {
    return toolPairingBalancedAfter(session, nodes[nodes.length - 1])
  } catch {
    return false
  }
}

console.log(`\ntoolPairingBalancedAfter(tail)  = ${after}`)
console.log(`toolPairingBalancedBefore(tail) = ${beforeTail}`)
console.log(`canAppendToSurface(session)     = ${canAppendToSurface(s)}`)
console.log(`\n=> the guard ${canAppendToSurface(s) ? 'ALLOWS' : 'BLOCKS'} the notice append`)
console.log(`=> patched code would have produced a notice here: ${canAppendToSurface(s) ? 'YES (bug remains!)' : 'NO (bug fixed)'}`)

// Control: the same guard on a balanced surface must allow the append, or the
// notice would never appear anywhere.
const control = makeSession([7, 8, 9, 10])
console.log(`\ncontrol (balanced tail seq 10): canAppendToSurface = ${canAppendToSurface(control)}`)
