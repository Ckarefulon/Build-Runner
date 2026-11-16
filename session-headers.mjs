// Print the `config` object of each request/header event in a DSH session file.
// usage: node session-headers.mjs <file.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file] = process.argv.slice(2)
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
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'request/header') continue
  const h = ev.data?.header ?? {}
  console.log(`seq=${ev.seq} reason=${ev.data?.reason} tools=${h.tools?.length ?? 'none'} config=${JSON.stringify(h.config)}`)
  console.log(`   headerKeys=${Object.keys(h).join(',')} msgCount=${h.messages?.length ?? 'n/a'}`)
}
