// Generate `preset-<id>` override patches that mount a scoped smart-compaction
// row as a sibling of compaction-basic inside each preset's isolated
// `compaction` group.
//
// Why a whole-declaration override: `applyEntryPatches` (dsh-app-boot) builds
// its id->entry index by recursing ONLY into rows with `group: true` whose
// config is an entry list. A preset declaration is not a group — its plugin
// list lives under `config.plugins` — so `- id: compaction / insert:` can never
// resolve ("patch insert: entry compaction not found"). `config` is replaced
// wholesale, so the entire declaration must be restated. This is the same shape
// the Web preset editor writes ("Edits saved from the Web editor override this
// row's `config.plugins` by id from the profile patch").
//
// Line surgery, not a YAML round-trip: the preset bodies contain `!!js` scalars
// whose tag a plain dump would drop, silently turning e.g.
// `disabled: !!js process.platform === 'win32'` into a truthy string.
import fs from 'node:fs'

const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? String.raw`C:\Users\Vxiao\.dsh\profiles\desktop`
const CORDIS = `${PROFILE_DIR}\\cordis.yml`
const OUT = process.argv[2] ?? new URL('./preset-overrides.generated.yml', import.meta.url)
const dryRun = process.argv.includes('--dry-run')

// Normalize line endings and strip a BOM: cordis.yml is LF and BOM-free, but a
// copy routed through a Windows tool (e.g. `--dump-config | Out-File`) comes
// back CRLF, and the `$`-anchored patterns below would then never match.
const lines = fs.readFileSync(CORDIS, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)

// Split the file into top-level rows.
const blocks = []
for (let i = 0; i < lines.length; i++) {
  const m = /^- id: (preset-[a-z0-9-]+)$/.exec(lines[i])
  if (!m) continue
  let end = i + 1
  while (end < lines.length && !/^- /.test(lines[end])) end++
  blocks.push({ id: m[1], body: lines.slice(i, end) })
}

const results = []
for (const { id, body: raw } of blocks) {
  // Drop any smart-compaction row a previous run already produced. cordis.yml is
  // regenerated at boot from the composed layers, so once this patch is live the
  // file the generator reads WILL contain the rows it added last time; without
  // this strip, a regeneration would report "already mounted" and emit an empty
  // file, silently reverting the fix.
  const body = []
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*- id: smart-compaction$/.test(raw[i])) {
      if (/^\s*name: smart-compaction$/.test(raw[i + 1] ?? '')) i++
      continue
    }
    // Layer-separator comments are added by `--dump-config` only; drop them so a
    // dump fed back in yields the same output as the plain cordis.yml.
    if (/^# == /.test(raw[i])) continue
    body.push(raw[i])
  }

  const groupIdx = body.findIndex(l => /^\s*- id: compaction$/.test(l))
  if (groupIdx === -1) { results.push({ id, action: 'SKIP (no compaction group)' }); continue }

  const groupIndent = body[groupIdx].match(/^\s*/)[0].length
  const childIndent = groupIndent + 4
  const prunerIdx = body.findIndex((l, n) => n > groupIdx && /^\s*- id: tool-result-pruner$/.test(l))
  if (prunerIdx === -1) { results.push({ id, action: 'SKIP (no tool-result-pruner)' }); continue }

  // Last line of the pruner item, i.e. before a line shallower than its siblings.
  let last = prunerIdx
  for (let n = prunerIdx + 1; n < body.length; n++) {
    if (body[n].trim() === '') continue
    if (body[n].match(/^\s*/)[0].length < childIndent) break
    last = n
  }

  const pad = ' '.repeat(childIndent)
  const row = [`${pad}- id: smart-compaction`, `${pad}  name: smart-compaction`]
  const patched = [...body.slice(0, last + 1), ...row, ...body.slice(last + 1)]
  results.push({ id, action: 'MOUNT', patched, childIndent })
}

for (const r of results) {
  console.log(`${r.id}: ${r.action}${r.childIndent !== undefined ? ` (row indent ${r.childIndent})` : ''}`)
}

const mounts = results.filter(r => r.action === 'MOUNT')
if (dryRun) {
  console.log(`\n(dry run) ${mounts.length} override(s) would be written`)
  process.exit(0)
}

const header = `# smart-compaction preset overrides — GENERATED, do not hand-edit.
#
# Problem: smart-compaction is installed as a profile bundle, so its row runs on
# the host plane. But @deepseek-ai/dsh-web-app disables the host-plane
# \`compaction-basic\` (disabled: true) and every preset mounts its own private
# instance inside a group carrying \`isolate: { compaction: true }\`. Cordis
# isolation is strictly downward: only plugins mounted as DESCENDANTS of that
# group resolve that service. The host-plane copy is its ANCESTOR, so
# \`ctx.get('compaction')\` returns undefined and compact_now fails with
# "no compaction service is configured on this profile" — while the automatic
# safe-point trigger silently no-ops on the same check.
#
# Fix: a second, scoped copy of the plugin as a sibling of compaction-basic
# inside the same group. dsh-tools scoped registrations shadow globals
# (ScopedLayers.merge), so both copies coexist; the scoped one serves the
# preset's agents. This is what smart-compaction's own
# scripts/mount-into-presets.mjs does for legacy $DSH_HOME/.agent-presets
# directories — it no-ops on this machine because this profile declares its
# presets inline in cordis.yml instead.
#
# Shape: a preset is changed by overriding its declaration row. A patch can NOT
# insert into the nested \`compaction\` group directly, because that group lives
# under the declaration's \`config.plugins\` (a declaration field), not in an
# entry list the patch engine indexes. And \`config\` is replaced wholesale, so
# each block restates the full shipped declaration. Regenerate after any preset
# change in the Web editor (which rewrites these same rows by id).`

fs.writeFileSync(OUT, `${header}\n\n${mounts.map(m => m.patched.join('\n')).join('\n\n')}\n`, 'utf8')
console.log(`\nwrote ${mounts.length} override(s) to ${OUT}`)
