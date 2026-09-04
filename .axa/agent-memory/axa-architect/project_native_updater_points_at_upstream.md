---
name: `axa install` downloads upstream Claude Code and installs it as `axa`
description: GCS_BUCKET_URL is Anthropic's claude-code-releases bucket, hardcoded in two files with no override; the automatic updater path is closed but the manual `axa install` command is open and reaches it
type: project
---

**Corrected 2026-09-04.** An earlier version of this memory asserted the wrong
mechanism (`isInBundledMode()` → `'native'` → `NativeAutoUpdater`). That chain is
**disproven** — see the trap at the bottom. The accurate statement is:

> **The automatic path is closed, the manual one is open.** `axa install` fetches
> upstream Claude Code from Anthropic's release bucket and installs it as `axa`.

**The live chain, verified in source.**

- `main.tsx` registers `program.command('install [target]')` **unconditionally**,
  immediately *above* the `if ("external" === 'ant')` ant-only block — so it is
  not gated.
- → `installHandler` (`cli/handlers/util.tsx`) → dynamic import of
  `commands/install.tsx` → `install.call(...)` → `installLatest(channelOrVersion,
  force)`.
- `installLatest` → `installLatestImpl` → `updateLatest` →
  `downloadVersionFromBinaryRepo(version, stagingPath, GCS_BUCKET_URL)`.
  Neither `updateLatest` nor `installLatestImpl` contains an installation-type
  gate. The only early exit needs `version === MACRO.VERSION` (2.1.87 vs bucket
  `stable` 2.1.236 — it does not fire).
- On success it writes `installMethod: 'native'`, `autoUpdates: false`,
  `autoUpdatesProtectedForNative: true` into the global config.

There are **three** callers of `installLatest`:

- `commands/install.tsx` — **no gate**, the open door described above.
- `components/NativeAutoUpdater.tsx` — never mounts (see the trap below).
- `cli/update.ts` — imported as `installLatest as installLatestNative`, called
  behind `diagnostic.installationType === 'native'`, so gated by the same
  always-false predicate.

*I originally wrote "exactly two" here, and so did two other reviewers. The third
was invisible to `rg` because an unanchored `.gitignore` pattern hid all of
`src/cli/` — see `reference_gitignore_hides_src_cli_from_grep.md`. The alias
import means it would also survive a grep for `installLatest(`.*

**The destination.** `GCS_BUCKET_URL` is hardcoded — identically, in **two** files
(`utils/autoUpdater.ts`, `utils/nativeInstaller/download.ts`) — to
`…/claude-code-dist-…/claude-code-releases`. No env override: grepping
`claude-code-dist`, `BINARY_REPO`, `DOWNLOAD_URL` across `src/` returns only those
two constants. It is live, not theoretical: `GET …/claude-code-releases/stable` →
`2.1.236` (bogus channel → `NoSuchKey`, so the probe ran); the version's
`manifest.json` is real — `"binary": "claude"`, per-platform sha256, ~317 MB.

`getBaseDirectories()` builds every path from `BINARY_NAME`, and the user-bin
symlink is named by `getInstalledBinaryName()` = `axa`. So the upstream binary
lands **as `axa`**.

**Two attenuations conceded to `fix-m6`, both worth keeping:**

- The binary-name split (`getBinaryName()` → `claude`,
  `getInstalledBinaryName()` → `axa`) is **deliberate and commented** in
  `installer.ts`: it avoids overwriting a real Claude Code install. Do not report
  it as an oversight.
- Checksum verification against `manifest.json` **passes**, because the artefact
  *is* the authentic upstream binary. Integrity checking cannot distinguish
  "right binary" from "wrong product" — which is why nothing errors.

**The aggravation, from `fix-m10` — the destination was forked and the source was
not, *in the same function*.** `installer.ts` has a deliberate comment above
`getInstalledBinaryName()`: *"Ours, not upstream's: installing as
`~/.local/bin/claude` would overwrite a Claude Code native install and hand it
our version manager."* So someone worked in this exact function, saw the
collision, and fixed which **name** the artefact lands under — while
`getBinaryName()`, two functions above, still returns `'claude'` and still names
the artefact **fetched from Anthropic's bucket**. Being uncollided is *worse*
here: had it kept upstream's name, `axa install` would visibly stomp a Claude
Code install and someone would have noticed in a day. Made polite, upstream's
binary lands cleanly on **our** name and nothing looks wrong. A fix that removed
the symptom and preserved the defect.

**Two more, both verified by me at source:**

- `main.tsx` describes the command as `` Install ${PRODUCT_NAME} native build `` —
  "Install AXA Chat native build". Not merely stale wording: **actively false**.
  The user runs it *because* the description says it installs this product.
- `installLatestImpl` persists `installMethod: 'native'`, `autoUpdates: false`,
  `autoUpdatesProtectedForNative: true` to global config on success — so it also
  silently rewrites the user's update configuration, and the comment there
  justifies it by saying native installs "use NativeAutoUpdater instead", which
  does not mount.

**Trap that produced my original error:** see
`reference_isinbundledmode_is_not_compiled.md`. Short form —
`isInBundledMode()`'s docstring is false, the predicate is
`Bun.embeddedFiles.length > 0` and that is 0 here, so
`getCurrentInstallationType()` never reaches `'native'` and `NativeAutoUpdater`
never mounts. `fix-m10` caught it.

But `fix-m10` then made the mirror error: they proved *one* entry point dead and
concluded the whole thing was inert. **Proving a path dead proves nothing until
you have established that path was the one that runs.** Both halves of this
episode are the same mistake in opposite directions.

**Contrast — the npm path is genuinely inert.** `MACRO.PACKAGE_URL` = `pkg.name`
= `axa-chat`, `private: true`, `npm view axa-chat version` → **E404** (control:
`npm view react version` → a real version), so `getLatestVersion()` returns null.
`MACRO.NATIVE_PACKAGE_URL` is defined as `undefined` in `scripts/build.ts`.

**Why this is a seam, not one area's bug.** Every piece is faithful to upstream
and correct in isolation — which is why no area owner has cause to look. This is
the first confirmed **upstream-anchor** instance (the second is the MDM/policy
surface): the fork localised its *destination* (`BINARY_NAME`, `PRODUCT_NAME`,
config dir) and left the *origin* pointing at the product it forked from.

**How to apply:** must not ride inside any feature branch — it is a distribution
decision (repoint, disable, or ship a fork bucket) and belongs to the lead with
`axa-platform`. When auditing `AutoUpdater*.tsx`, `utils/autoUpdater.ts` or
`utils/nativeInstaller/`, state reachability in terms of the *manual* command, not
the automatic updater.

**Do NOT defer `commands/install.tsx` `getInstallationPath()` to the product-name
pass — it is a divergent twin, not a string.** It hardcodes
`~/.local/bin/claude` (and a Windows leg `…/bin/claude.exe` behind a platform
conditional, which a reviewer who has just fixed the line below it will read as
already handled). The authority is `getBaseDirectories()` in `installer.ts`:
`executable: join(getUserBinDir(), executableName)` with `executableName =
getInstalledBinaryName()` = `axa`. So the success screen renders **the wrong
path** under the heading `` {PRODUCT_NAME} successfully installed! `` — it names
a file the installer did not create. `installer.ts` has the same defect in a
comment: *"Create direct symlink from `~/.local/bin/claude`"* sits above code
whose `executablePath` is derived from `getInstalledBinaryName()`. The genuine
product-name items on that screen are separate: "Next: Run `claude --help`".
(`color="claude"` on the same screen is a theme colour name and is **not** on
this axis.)
