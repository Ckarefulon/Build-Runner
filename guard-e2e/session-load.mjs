// Shared session loader: reads a DSH session log as either a plain .jsonl or a
// multi-frame .jsonl.zstd (frame-split on the zstd magic — a single
// zstdDecompressSync only decodes the first frame).
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

export function loadEvents(file) {
  const buf = readFileSync(file)
  let text
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  if (buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC)) {
    const starts = []
    let idx = 0
    while ((idx = buf.indexOf(MAGIC, idx)) !== -1) { starts.push(idx); idx += 4 }
    starts.push(buf.length)
    const parts = []
    for (let i = 0; i < starts.length - 1; i++) {
      try { parts.push(zstdDecompressSync(buf.subarray(starts[i], starts[i + 1]))) } catch {}
    }
    text = Buffer.concat(parts).toString('utf8')
  } else {
    text = buf.toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

export const SURFACE_EVENT_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
])

/** Fold the model-visible surface, honouring replace ops. */
export function buildSurface(events, skipSeq = null) {
  const bySeq = new Map(events.map(e => [e.seq, e]))
  let surface = []
  const replaceLog = []
  for (const ev of events) {
    if (skipSeq !== null && ev.seq === skipSeq) continue
    const op = ev.surfaceOp
    if (op !== undefined && op !== 'append') {
      const si = surface.indexOf(op.startSeq)
      const ei = surface.indexOf(op.endSeq)
      replaceLog.push({ at: ev.seq, startSeq: op.startSeq, endSeq: op.endSeq, si, ei })
      if (si === -1 || ei === -1) { surface.push(ev.seq); continue }
      surface = [...surface.slice(0, si), ev.seq, ...surface.slice(ei + 1)]
      continue
    }
    if (SURFACE_EVENT_TYPES.has(ev.type)) surface.push(ev.seq)
  }
  return { surface, bySeq, replaceLog }
}

export function describeEvent(ev) {
  if (!ev) return '<missing>'
  const d = ev.data ?? {}
  if (ev.type === 'assistant/message') {
    const blocks = d.message?.content ?? []
    return `${ev.seq} assistant[${blocks.map(b => b.type === 'tool-call' ? `tool-call(${b.name})` : b.type).join(',')}]`
  }
  if (ev.type === 'tool/result') {
    const cid = d.toolCallId ?? d.message?.toolCallId
    return `${ev.seq} tool/result(${cid})`
  }
  if (ev.type === 'user/message' || ev.type === 'system/message' || ev.type === 'developer/message') {
    const content = d.content ?? d.message?.content
    const txt = Array.isArray(content)
      ? content.map(c => c.text ?? '').join('')
      : String(content ?? '')
    return `${ev.seq} ${ev.type}[src=${d.source?.kind ?? '?'}${d.source?.form ? '/' + d.source.form : ''}] "${txt.replace(/\s+/g, ' ').slice(0, 70)}"`
  }
  return `${ev.seq} ${ev.type}`
}

/** Tool-call/result pairing audit over a surface. */
export function auditPairing(surface, bySeq) {
  const violations = []
  const pending = []
  for (let i = 0; i < surface.length; i++) {
    const ev = bySeq.get(surface[i])
    if (!ev || ev.type !== 'assistant/message') continue
    const calls = (ev.data?.message?.content ?? []).filter(b => b.type === 'tool-call')
    if (calls.length === 0) continue
    const ids = new Set(calls.map(c => c.id))
    const answered = new Set()
    let bad = null
    for (let j = i + 1; j < surface.length && answered.size < ids.size; j++) {
      const nx = bySeq.get(surface[j])
      if (!nx) continue
      if (nx.type === 'tool/result') {
        const cid = nx.data?.toolCallId ?? nx.data?.message?.toolCallId
        if (ids.has(cid)) answered.add(cid)
        else { bad = `tool/result(unknown ${cid})`; break }
        continue
      }
      bad = describeEvent(nx)
      break
    }
    if (answered.size < ids.size || bad) {
      const atTail = i === surface.length - 1
      if (atTail && bad === null) { pending.push({ at: surface[i] }); continue }
      violations.push({ at: surface[i], answered: answered.size, total: ids.size, interposed: bad })
    }
  }
  return { violations, pending }
}
