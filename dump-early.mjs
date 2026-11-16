// Dump the head of a session (metadata + first events), summarising the
// request/header instead of printing 50 KB of tool schemas.
// usage: node dump-early.mjs <session.v4.jsonl[.zstd]> [maxSeq]
import { loadEvents } from './session-load.mjs'

const [file, maxS] = process.argv.slice(2)
const maxSeq = maxS === undefined ? 15 : Number(maxS)
const events = loadEvents(file)
for (const e of events) {
  if (e.seq !== undefined && e.seq > maxSeq) continue
  if (e.type === 'request/header') {
    const d = e.data ?? {}
    const tools = d.tools ?? d.header?.tools
    console.log(`seq ${e.seq} request/header  tools=${Array.isArray(tools) ? tools.length : '?'}  reason=${d.reason}`)
    console.log('  data keys: ' + Object.keys(d).join(','))
    console.log('  config: ' + JSON.stringify(d.config ?? d.header?.config ?? {}).slice(0, 420))
    continue
  }
  console.log(`seq ${e.seq} ${e.type} :: ${JSON.stringify(e).slice(0, 700)}`)
}
