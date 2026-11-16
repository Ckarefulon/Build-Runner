// Minimal asar reader: list / extract / grep entries from an .asar archive.
// usage: node asar-read.mjs <asar> list <substr>
//        node asar-read.mjs <asar> read <entryPath>
//        node asar-read.mjs <asar> grep <regex> [substr]
import { open } from 'node:fs/promises'

const [asarPath, cmd, arg, arg2] = process.argv.slice(2)
const fh = await open(asarPath, 'r')

const head = Buffer.alloc(16)
await fh.read(head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
await fh.read(jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = 16 + jsonLen

function* walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) yield* walk(entry, p)
    else if (entry.link !== undefined) yield { path: p, size: entry.size, offset: entry.offset, link: entry.link }
    else yield { path: p, size: entry.size, offset: entry.offset }
  }
}

async function readEntry(e) {
  const size = Number(e.size)
  if (!Number.isFinite(size) || !Number.isFinite(Number(e.offset))) throw new Error(`entry has no data (link?): size=${e.size} offset=${e.offset}`)
  const off = baseOffset + Number(e.offset)
  const buf = Buffer.alloc(size)
  let done = 0
  while (done < size) {
    const { bytesRead } = await fh.read(buf, done, size - done, off + done)
    if (bytesRead <= 0) break
    done += bytesRead
  }
  return buf
}

if (cmd === 'list') {
  for (const e of walk(header, '')) if (!arg || e.path.includes(arg)) console.log(e.size, e.path)
} else if (cmd === 'read') {
  const e = [...walk(header, '')].find(x => x.path === arg)
  if (!e) { console.error('not found'); process.exit(1) }
  process.stdout.write(await readEntry(e))
} else if (cmd === 'grep') {
  const re = new RegExp(arg, 'g')
  for (const e of walk(header, '')) {
    if (arg2 && !e.path.includes(arg2)) continue
    if (Number(e.size) > 8_000_000) continue
    if (!Number.isFinite(Number(e.offset))) continue
    const buf = await readEntry(e)
    if (buf.includes(0)) continue
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (re.test(line)) { re.lastIndex = 0; console.log(`${e.path}:${i + 1}: ${line.trim().slice(0, 200)}`) }
    })
  }
} else {
  console.error('usage: list|read|grep')
  process.exit(2)
}
await fh.close()
