// Append the generated smart-compaction preset overrides to the profile's own
// patch layer, replacing any previous generated block (idempotent).
//
// Regenerate after any preset change: `node generate-preset-overrides.mjs`
// then `node apply-preset-overrides.mjs`.
import fs from 'node:fs'

const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? String.raw`C:\Users\Vxiao\.dsh\profiles\desktop`
const PATCH = `${PROFILE_DIR}/cordis.patch.yml`
const BACKUP = `${PATCH}.before-smart-compaction.bak`
const MARKER = '# smart-compaction preset overrides — GENERATED, do not hand-edit.'
const generated = fs.readFileSync(new URL('./preset-overrides.generated.yml', import.meta.url), 'utf8')

let cur = fs.readFileSync(PATCH, 'utf8')
const idx = cur.indexOf(MARKER)
const hadBlock = idx >= 0
if (hadBlock) cur = cur.slice(0, idx)
cur = cur.replace(/\s*$/, '') + '\n'

// Keep the pristine pre-fix layer the first time only, so a re-run cannot
// overwrite the real backup with an already-patched file.
if (!fs.existsSync(BACKUP)) fs.copyFileSync(PATCH, BACKUP)
fs.writeFileSync(PATCH, `${cur}\n${generated}`, 'utf8')

console.log(`${hadBlock ? 'replaced' : 'appended'} generated block in ${PATCH}`)
console.log(`backup: ${BACKUP}`)
