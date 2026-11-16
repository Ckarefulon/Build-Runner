// End-to-end test of the REAL shipped plugin file: load it, register its
// tools, then invoke `compact_now` against a session surface reconstructed
// from a real failing log — and observe whether the notice is appended.
// usage: node e2e-guard.mjs <pluginDir> <sessionFile>
import { loadEvents, buildSurface } from './session-load.mjs'

const [pluginDir, sessionFile] = process.argv.slice(2)
const events = loadEvents(sessionFile)
const bySeq = new Map(events.map(e => [e.seq, e]))

// Rebuild the surface exactly as it was the instant compact_now's execute()
// ran: every event before the notice the buggy build appended.
const notice = events.find(e => e.data?.source?.kind === 'smart-compaction')
const cutoff = notice ? notice.seq : Infinity
const { surface } = buildSurface(events.filter(e => e.seq < cutoff))
console.log(`surface at execute() time: [${surface.join(', ')}]`)
console.log(`tail: seq ${surface.at(-1)} = ${bySeq.get(surface.at(-1))?.type}`)

// The session the plugin will see, plus a recording append().
const appended = []
const session = {
  surface: { nodes: [...surface], replaceGeneration: 1 },
  eventAt: seq => bySeq.get(seq),
  append: (type, data, opts) => {
    appended.push({ type, data, opts })
    const seq = 10000 + appended.length
    bySeq.set(seq, { seq, type, data, surfaceOp: opts?.surfaceOp })
    if (opts?.surfaceOp === 'append') session.surface.nodes.push(seq)
    return { seq }
  },
}

// compactRegion stub: report what the plugin passed, and do NOT append the
// notice ourselves (only the plugin under test can do that).
let regionArgs = null
const compaction = {
  async compactRegion(start, end) {
    regionArgs = { start, end }
    return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 42 }
  },
}

const registered = []
const ctx = {
  tools: { register: def => registered.push(def) },
  get: name => (name === 'compaction' ? compaction : undefined),
  on: () => {},
}

const mod = await import(`file:///${pluginDir.replace(/\\/g, '/')}/index.js`)
mod.apply(ctx, { safePointRatio: false })

const tool = registered.find(d => d.name === 'compact_now')
if (!tool) throw new Error('compact_now was not registered')
console.log(`\nplugin exports: ${Object.keys(mod).join(', ')}`)
console.log(`registered tools: ${registered.map(d => d.name).join(', ')}`)

const result = await tool.execute({}, { agent: { session }, signal: undefined })
console.log(`\ncompact_now returned: ${JSON.stringify(result)}`)
console.log(`compactRegion called with: ${JSON.stringify(regionArgs)}`)

const notices = appended.filter(a => a.data?.source?.kind === 'smart-compaction')
console.log(`\nnotices appended: ${notices.length}`)
for (const n of notices) console.log(`  ${n.type} surfaceOp=${n.opts?.surfaceOp}`)

const finalNodes = session.surface.nodes
console.log(`final surface: [${finalNodes.join(', ')}]`)

// The real question: is any non-result node interposed between the open
// tool-call and its result?
const tailCallSeq = surface.at(-1)
const after = finalNodes.slice(finalNodes.indexOf(tailCallSeq) + 1)
console.log(`nodes appended after the open tool-call: [${after.join(', ')}]`)
const interposed = after.filter(s => bySeq.get(s)?.type !== 'tool/result')
console.log(`\n=> ${interposed.length === 0 ? 'PASS: no interposed node (surface stays valid)' : `FAIL: interposed [${interposed.join(', ')}] -> would cause HTTP 400`}`)
process.exit(interposed.length === 0 ? 0 : 1)
