// Print the histogram of event types in a DSH session file.
// usage: node session-types.mjs <file.zstd>
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
const counts = new Map()
let total = 0
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  total++
  counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1)
}
console.log(`total ${total} events`)
for (const [t, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(String(c).padStart(6), t)
