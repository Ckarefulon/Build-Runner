// Decompress a multi-frame DSH session .jsonl.zstd (concatenated zstd frames)
// and print lines matching a regex.
// usage: node session-read.mjs <file.zstd> <regex> [contextChars] [maxMatches]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, pattern, ctx, maxM] = process.argv.slice(2)
const maxMatches = Number(maxM ?? 50)
const width = Number(ctx ?? 400)

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Split on frame magic; decompress each slice, tolerating a trailing partial.
const starts = []
let idx = 0
while ((idx = buf.indexOf(MAGIC, idx)) !== -1) { starts.push(idx); idx += 4 }
starts.push(buf.length)

const parts = []
let failed = 0
for (let i = 0; i < starts.length - 1; i++) {
  const slice = buf.subarray(starts[i], starts[i + 1])
  try { parts.push(zstdDecompressSync(slice)) } catch { failed++ }
}
const text = Buffer.concat(parts).toString('utf8')

const re = new RegExp(pattern)
let n = 0
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  if (re.test(line)) {
    n++
    if (n > maxMatches) { console.log(`--- (more than ${maxMatches} matches, stopping) ---`); break }
    console.log(`--- match ${n} (line ${line.length} chars) ---`)
    console.log(line.length > width ? line.slice(0, width) + ' …' : line)
  }
}
console.error(`[${n} matches, ${text.length} chars, ${parts.length} frames ok / ${failed} failed, ${file}]`)
