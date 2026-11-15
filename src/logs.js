/**
 * Turn a raw GitHub Actions job log into a build-runner result.
 *
 * GitHub's log endpoint returns every step's output with timestamp prefixes
 * ("2024-01-01T00:00:00.0000000Z ") and `##[group]` / `::group::` markers. The
 * calling AI only wants what the command itself printed, so we isolate the
 * region between our own begin/end sentinels and strip the rest.
 */

const TS_PREFIX = /^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/

export const MARKERS = {
  begin: '--- BUILD-RUNNER-OUTPUT-BEGIN ---',
  end: '--- BUILD-RUNNER-OUTPUT-END ---',
  exitCode: /BUILD-RUNNER-EXIT-CODE=(-?\d+)/,
  duration: /BUILD-RUNNER-DURATION-SECONDS=(\d+)/,
  shell: /BUILD-RUNNER-SHELL=(\S+)/,
  report: '================ BUILD-RUNNER-REPORT-V1 ================',
}

function stripTimestamps(line) {
  let out = line.replace(/\r$/, '')
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(TS_PREFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * @param {Buffer|string} raw complete job log
 * @returns {{output:string, exitCode:number|null, durationSeconds:number|null,
 *            shell:string|null, report:Record<string,string>, hasSection:boolean,
 *            lines:number, bytes:number}}
 */
export function parseJobLog(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  const rawLines = text.split('\n')
  const lines = rawLines.map(stripTimestamps)

  const beginAt = lines.findIndex(line => line.includes(MARKERS.begin))
  const endAt = lines.findIndex((line, index) => index > beginAt && line.includes(MARKERS.end))
  const hasSection = beginAt !== -1 && endAt !== -1

  const output = hasSection ? lines.slice(beginAt + 1, endAt).join('\n') : ''

  const joined = lines.join('\n')
  const exitMatch = joined.match(MARKERS.exitCode)
  const durationMatch = joined.match(MARKERS.duration)
  const shellMatch = joined.match(MARKERS.shell)

  // The Report step prints `key=value` pairs; collect them so the caller can
  // prove which revision actually ran.
  const report = {}
  const reportAt = lines.findIndex(line => line.includes(MARKERS.report))
  if (reportAt !== -1) {
    for (let i = reportAt + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.includes('=====')) break
      const eq = line.indexOf('=')
      if (eq > 0) report[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }

  return {
    output,
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    durationSeconds: durationMatch ? Number(durationMatch[1]) : null,
    shell: shellMatch ? shellMatch[1] : null,
    report,
    hasSection,
    lines: output === '' ? 0 : output.split('\n').length,
    bytes: Buffer.byteLength(output, 'utf8'),
  }
}

/**
 * Keep the head and the tail of a long log — errors live at the end, but the
 * opening lines usually name the failing target.
 */
export function clip(text, { maxChars = 24000, headChars = 6000 } = {}) {
  if (typeof text !== 'string' || text.length <= maxChars) {
    return { text, truncated: false }
  }
  const tailChars = Math.max(maxChars - headChars, 1000)
  const head = text.slice(0, headChars)
  const tail = text.slice(-tailChars)
  const omitted = text.length - head.length - tail.length
  return {
    text: `${head}\n\n... [build-runner: 省略了 ${omitted} 个字符 / ${(
      omitted / 1024
    ).toFixed(1)} KiB 中间输出] ...\n\n${tail}`,
    truncated: true,
    omitted,
  }
}

/** Pull a concise failure summary out of raw log text. */
export function summarizeFailure(output) {
  if (!output) return null
  const lines = output.split('\n')
  const patterns = [
    /\berror(\s*\[?[A-Z]+\d*\]?)?:/i,
    /^FAIL(ED)?\b/i,
    /^\s*E\s{2,}/,
    /Exception|Traceback|panic:/,
    /cannot find|not found|No such file/i,
    /npm ERR!/,
    /BUILD FAILED|BUILD SUCCESSFUL/,
  ]
  const hits = []
  for (const line of lines) {
    if (line.trim() === '') continue
    if (patterns.some(re => re.test(line))) {
      hits.push(line.trim())
      if (hits.length >= 12) break
    }
  }
  return hits.length > 0 ? hits : null
}
