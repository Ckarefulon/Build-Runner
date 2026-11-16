// Diff the tool-name sets of two request/header events in a DSH session file.
// usage: node session-tooldiff.mjs <file.zstd> <seqA> <seqB>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, a, b] = process.argv.slice(2)
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
const found = {}
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'request/header') continue
  if (String(ev.seq) !== a && String(ev.seq) !== b) continue
  found[String(ev.seq)] = (ev.data?.header?.tools ?? []).map(t => t.name)
}
const [na, nb] = [found[a] ?? [], found[b] ?? []]
console.log(`seq ${a}: ${na.length} tools`)
console.log(`seq ${b}: ${nb.length} tools`)
const sa = new Set(na), sb = new Set(nb)
console.log(`only in ${a}:`, na.filter(x => !sb.has(x)).join(', ') || '(none)')
console.log(`only in ${b}:`, nb.filter(x => !sa.has(x)).join(', ') || '(none)')
console.log(`order identical:`, JSON.stringify(na) === JSON.stringify(nb))
