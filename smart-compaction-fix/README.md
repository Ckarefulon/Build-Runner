# smart-compaction on this profile

Makes `compact_now` / `context_status` (and the automatic safe-point trigger)
work on the `desktop` profile.

## Symptom

`compact_now` threw the plugin's own error:

```
compact_now: no compaction service is configured on this profile
```

`context_status` worked, so the plugin was loaded — only the compaction service
lookup failed. The automatic safe-point compaction was silently inert on the
same check (`if (!compaction) return next()` in `index.js`).

## Root cause

`smart-compaction` is installed as a profile bundle, so its entry
(`- id: tool-compact-now`) runs on the **host plane**. But the preset declares
its own private compaction instance inside a group carrying
`isolate: { compaction: true }`, and `@deepseek-ai/dsh-web-app` disables the
host-plane `compaction-basic` (`disabled: true`).

Cordis isolation is strictly **downward**: only plugins mounted as *descendants*
of that group can resolve the group's service. The host-plane copy is an
*ancestor*, so `ctx.get('compaction')` is always `undefined` there.

The plugin already handles this correctly — its own
`scripts/mount-into-presets.mjs` postinstall mounts a scoped copy next to
`compaction-basic`. It no-ops here because it patches
`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`, and this profile declares its
presets inline in `cordis.yml` instead.

## Fix

A second, scoped copy of the plugin as a sibling of `compaction-basic` inside
each preset's isolated `compaction` group. Scoped registrations shadow globals,
so the host-plane copy and the scoped copy coexist.

The rows are appended to `cordis.patch.yml` as `preset-<id>` overrides.
**`config` is replaced wholesale**, so each block restates the full declaration.

A patch can *not* insert into the nested `compaction` group directly:
`applyEntryPatches` (`@deepseek-ai/dsh-app-boot`) builds its id index by
recursing only into rows with `group: true`, and a preset's plugin list lives
under `config.plugins` — a declaration field, not an entry list.

## Files

| file | role |
| --- | --- |
| `generate-preset-overrides.mjs` | rewrites `preset-overrides.generated.yml` from the composed `cordis.yml` |
| `apply-preset-overrides.mjs` | appends that block to `cordis.patch.yml` (idempotent) |
| `preset-overrides.generated.yml` | the generated block, as deployed |

## Regenerating

Run this after changing a preset (e.g. in the Web preset editor — it rewrites
these same rows by id and would otherwise drop the `smart-compaction` row):

```powershell
cd smart-compaction-fix
node generate-preset-overrides.mjs
node apply-preset-overrides.mjs     # needs write access outside the workspace
```

Both scripts honour `DSH_PROFILE_DIR` (default
`C:\Users\Vxiao\.dsh\profiles\desktop`).

Regeneration is idempotent and reads either the plain `cordis.yml` or a
post-boot `--dump-config` composition. It strips any rows a previous run added,
so a regeneration can never silently revert the fix; line endings and a BOM are
normalized, and the `!!js` tags in the preset bodies are preserved verbatim
(a YAML round-trip would drop the tag and turn
`disabled: !!js process.platform === 'win32'` into a truthy string, enabling
*both* bash and pwsh).

`cordis.yml` is a generated artifact rewritten at boot — never edit it directly.

## Verification

Composition was verified with DSH's real algorithm, by lifting
`applyEntryPatches` verbatim out of the shipped `dsh-app-boot` bundle and by
running the real CLI against a throwaway profile:

```powershell
dsh --profile <probe> --dump-config
```

Result: exactly 5 scoped rows (one per preset that has a compaction service),
each inside a group with `isolate: { compaction: true }`; `preset-minimal` has
no compaction group and is untouched; no new patch warnings.

The two `not found` warnings for `dsh-whale-pet` and `mcp-manager` are
pre-existing and unrelated — they appear identically without this change.

## Still required

**Restart DeepSeek Harness.** The composition is built at boot, and a session
keeps the plugin revision it started with, so `compact_now` works in a **new**
session after the restart.

Backup of the pre-fix layer:
`cordis.patch.yml.before-smart-compaction.bak`.

---

# Fix 2 — the HTTP 400 after compaction

Once `compact_now` worked, compacting made the *next* request fail:

```
本轮运行失败400: {"message":"workbuddy upstream client (http 400):
请求参数不符合当前模型要求，请调整后重试。","type":"client","code":"client"}
```

The tool call itself succeeded (`Compacted 180 history items (~132577 tokens).`),
so the failure is downstream — in the request assembled *after* compaction.

## Root cause

`compactAgent()` appended its "⏳ Compacting now" notice **before** calling
`compactRegion()`, and `compact_now` runs inside its own tool's `execute()`. So
the notice landed on the surface between the assistant message carrying
`tool-call(compact_now)` and that call's `tool/result`:

```
996  assistant[tool-call(compact_now)]   <- unanswered
998  user/message[src=smart-compaction/notice]   <- interposed here
1003 tool/result(compact_now)
```

An unanswered tool call interrupted by a user message is not a valid wire
sequence, so the upstream rejected the next request with HTTP 400
`INVALID_REQUEST`. The surface is durable, so the corruption persisted and
**every later turn of that session failed the same way** (turns 9 and 10 in the
crashed log) — the session was unrecoverable, not merely interrupted.

The checkpoint `compactRegion()` itself appends is harmless: it is a `replace`
op, which lands at the *start* of the shadowed range, never at the tail. Only
the plugin's plain `append` interposes.

`/compact` (`compactNow()`) never had this bug: it requires an **idle** agent,
so no tool call is open when it appends. Only the mid-turn `compactRegion()`
path — `compact_now` and the automatic safe-point trigger — is affected.

Upstream is affected too: 0.3.1, 0.3.2 and 0.3.5 have byte-identical
`index.js` here, and 0.3.5's README still documents posting the notice
"*before* calling `compactRegion()`, not after" as deliberate.

## Fix

Append the notice only when the cut after the last surface node is
tool-pairing balanced, using the same core helper the plugin already imports:

```js
function canAppendToSurface(session) {
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return false
  try {
    return toolPairingBalancedAfter(session, nodes[nodes.length - 1])
  } catch {
    return false
  }
}
```

Fails closed: if balance cannot be established, nothing is appended. Nothing is
lost visually — core's own `compaction/start` is appended by `compactRegion`
(`compaction-basic/lib/index.js:469`) *before* the slow summarization call at
line 478, and the chat UI renders `compaction/start` as a live condensing row
(`dsh-client-ui-chat/lib/client.js` `compactionDefinition`). The notice was only
ever a nicety on that path, never the load-bearing "looks stuck" signal.

## Files

| file | role |
| --- | --- |
| `index.js.orig-0.3.1` | pristine installed file (sha256 `DB7370FD…3F67`), for re-diffing |
| `index.js.patched` | the fixed file, as installed |
| `smart-compaction-notice-guard.patch` | unified diff, reapplyable with `git apply` |

Installed file after the fix: sha256 `798604DF…0812`.

Reapply after a `pnpm install` overwrites the package:

```powershell
cd smart-compaction-fix
git apply smart-compaction-notice-guard.patch   # run from the package dir
# or simply:
Copy-Item index.js.patched "$env:DSH_PROFILE_DIR\node_modules\smart-compaction\index.js" -Force
```

## Verification

Both directions were proven against the real crashed session
(`session-00642361-1761-4980-8d02-da1474c122bc`):

```powershell
node verify-guard.mjs  <session.v4.jsonl.zstd>   # guard decides
node simulate-fix.mjs  <session.v4.jsonl.zstd> 998
```

- `verify-guard.mjs` — at seq 998 the surface tail is
  `assistant[tool-call(compact_now)]` and the cut after it is **unbalanced**, so
  `canAppendToSurface` returns `false` and the append is blocked. It fires on
  exactly the one event that corrupted the surface.
- `simulate-fix.mjs` — replaying with that single event suppressed:
  `AS-IS pairing violations=1` → `WITH FIX pairing violations=0`.

So the guard is both **necessary** (it blocks the offending append) and
**sufficient** (removing that append yields a clean surface).

A session keeps the plugin revision it started with, so verify `compact_now` in
a **new** session: after compacting, the following turn must complete normally
and `node session-surface.mjs <session> pairing` must report
`pairing violations=0`.

## REQUIRED: restart DSH after installing this patch

**The patch is inert until the DSH app is fully restarted.** This is why the
first attempt still reproduced the bug in `session-1322b3a7-…` even though the
file on disk was already correct.

The Host is a long-lived Node process. Cordis loads each plugin with
`pathToFileURL` + native ESM `import()`, so:

- module code is cached by URL for the **whole process lifetime**;
- there is no cache-busting query and no file watcher;
- editing the file on disk therefore has **zero** effect on a running Host.

Behaviour is the reliable tell: the guard **fails closed**, so if the patched
code were executing, a notice could not possibly be appended on an unbalanced
tail. Session 1322 shows one at seq 18 → the running Host still held the old
module.

Check whether a restart is needed:

```powershell
$boot = (Get-Process -Name 'DeepSeek Harness' | Sort-Object StartTime | Select-Object -First 1).StartTime
$file = (Get-Item "$env:DSH_PROFILE_DIR\node_modules\smart-compaction\index.js").LastWriteTime
"app booted $boot / file patched $file / restart needed: $($file -gt $boot)"
```

Two traps when reading this:

- `C:\Users\Vxiao\.dsh\electron\electron.exe` is the **pet widget**
  (`dsh-pet-electron-helper`), *not* DSH — do not mistake it for a restart.
- Chromium's `lockfile` `CreationTime` is left over from an earlier crash
  (`logs\crash-*.log`) and does not date the current run. Use the process start
  time instead.

After restarting, confirm the fix in a fresh session: the guard should block the
notice during `compact_now`, so the chat will show only core's own
`compaction/start` "condensing" row (which is why nothing is lost visually).

## End-to-end proof that the shipped file is correct

`e2e-guard.mjs` imports the **actual installed** `index.js`, registers its real
tools, and invokes `compact_now` against the surface reconstructed from the
failing session:

```powershell
cd guard-e2e
node e2e-guard.mjs .\orig   ..\session-1322\session.v4.jsonl  # FAIL: interposed
node e2e-guard.mjs .\plugin ..\session-1322\session.v4.jsonl  # PASS: no interposed node
```

- `orig/` (pristine 0.3.1) appends the notice at the tail → the node lands
  between the open `tool-call` and its `tool/result` → would 400.
- `plugin/` (the patched, installed file) appends nothing → surface stays valid.

This isolates the defect to the code, independent of any session log, and proves
the installed artifact is the fixed one.

