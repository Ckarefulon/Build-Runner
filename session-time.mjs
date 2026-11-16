// Print wall-clock timestamps found in a session log, to place it in time.
// usage: node session-time.mjs <session.v4.jsonl[.zstd]>
import { loadEvents } from './session-load.mjs'

const [file] = process.argv.slice(2)
const events = loadEvents(file)
const ts = []
for (const e of events) {
  for (const m of JSON.stringify(e).matchAll(/"time":(\d{13})/g)) ts.push(Number(m[1]))
}
ts.sort((a, b) => a - b)
const fmt = t => new Date(t).toLocaleString('sv-SE')
if (ts.length === 0) {
  console.log('no 13-digit "time" fields found')
} else {
  console.log(`session first event: ${fmt(ts[0])}`)
  console.log(`session last  event: ${fmt(ts.at(-1))}`)
}
console.log(`now                : ${new Date().toLocaleString('sv-SE')}`)
console.log(`\nevents: ${events.length}, seq ${events[0]?.seq}..${events.at(-1)?.seq}`)
// Session metadata, if present.
const meta = events.find(e => e.type === 'session')
if (meta) console.log('session event data: ' + JSON.stringify(meta.data).slice(0, 400))
