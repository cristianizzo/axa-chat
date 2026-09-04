---
name: `axa install` installs upstream Claude Code, unresolved
description: The `install` subcommand downloads Anthropic's Claude Code binary from the GCS releases bucket and installs it as `axa`; open as of 2026-09-04, decision pending with the lead.
type: project
---

`program.command('install [target]')` is registered unconditionally in
`src/main.tsx` (above the `if ("external" === 'ant')` block, not inside it) and
reaches `installLatest` with **no installation-type gate** anywhere on the path.
It downloads from `GCS_BUCKET_URL` in `src/utils/nativeInstaller/download.ts`,
Anthropic's `claude-code-releases` bucket, and on success persists
`installMethod: 'native'` + `autoUpdates: false` to global config.

The load-bearing detail: a previous fork author **already fixed the destination
and not the source**. `getInstalledBinaryName()` returns `BINARY_NAME` (`axa`)
with a comment explaining that installing as `~/.local/bin/claude` would
overwrite a real Claude Code install — while `getBinaryName()` directly above it
still returns `'claude'` and names the artifact fetched from upstream's bucket.

**Why:** the collision-avoidance is what conceals the defect. Upstream's binary
lands cleanly on the fork's own name instead of visibly stomping something, so
nothing looks wrong. A symptom removed with the cause preserved is worse than
either extreme, and it is why this survived.

The success screen compounds it. Three independent strings in
`src/commands/install.tsx` — the product name, the `Location:` value from a
local `getInstallationPath()` that hardcodes `~/.local/bin/claude`, and a
literal `claude --help` next step — are each answered from a constant rather
than from `getBaseDirectories()` / `BINARY_NAME`. The one value that *was*
localised is consulted by none of them, so the screen is internally consistent
with upstream Claude Code and does not read as a bug. A stale comment above
`updateSymlink` in `nativeInstaller/installer.ts` names the same wrong path.

**The three defects need three different fixes — do not apply one rule to all
of them.** What decides the fix is what kind of fact the string is:

- The **path** literals are divergent twins of `getBaseDirectories().executable`.
  Substituting `BINARY_NAME` yields a hardcoded string that merely happens to
  agree and stops agreeing the next time the destination moves. Delete the twin
  and read from the derived value.
- The **comment** cannot interpolate at all, so the fix is naming the symbol
  rather than restating the value.
- The **rendered `claude --help`** is a binary name in UI, and `BINARY_NAME`
  genuinely is its authority: `getInstalledBinaryName()` returns `BINARY_NAME`,
  so an interpolated `{BINARY_NAME} --help` tracks the same source that decides
  what lands on disk. It cannot drift. Interpolating here is correct.

General cut, agreed with fix-m20: **in rendered UI always interpolate; the
literal-is-fine exception belongs to comments only**, where a brace form would
promise a link that cannot exist.

The `claude --help` line is not rescued by the `claude` bin alias in
`package.json`. Both aliases ship, so on an **npm** install it resolves — but
this screen renders only after a **native** install, whose sole artifact is
`~/.local/bin/axa` and which never writes npm bin aliases. The deciding factor
is the install *method*, not the string; "there's a `claude` alias in
package.json" is a rebuttal that looks decisive and is not.

`install.tsx:241` is **not** a defect of this class — it already interpolates
`PRODUCT_NAME`. Its claim is false only because of what the command installs,
so it disappears if the source is repointed. Keep it out of string-defect lists:
a correct site inside such a list gets either "fixed" into something worse or
treated as already-audited noise.

**Scope correction — the *automatic* leg is closed.** An earlier report of mine
said a native `axa` would silently self-update into Claude Code; that was wrong.
`isInBundledMode()` is `Bun.embeddedFiles.length > 0`, **false** for our binary,
so `getCurrentInstallationType()` never returns `'native'` and `NativeAutoUpdater`
never mounts (fix-m10 proved it with a two-variant compiled probe: plain binary
`len: 0`; a variant with one `with { type: "file" }` import `len: 1`). Only the
**user-typed** `axa install` survives — materially lower severity, and the
distinction must be carried whenever this is re-reported.

`installLatest` has **three** callers, not the two that three of us confidently
enumerated: `commands/install.tsx` (open), `NativeAutoUpdater` (closed), and
`src/cli/update.ts` — aliased as `installLatestNative` and gated on
`getDoctorDiagnostic().installationType === 'native'`, so closed by the same
proof. It was doubly hidden: behind an alias import *and* inside `src/cli/`,
which an unanchored `cli` rule in `.gitignore` made invisible to ripgrep. Count
the callers with `--no-ignore` before asserting a number.

**Two traps for whoever fixes the screen.** `getInstallationPath()` has a
*Windows branch* that builds `.local/bin/claude.exe` above the `~/.local/bin/claude`
return — behind `if (isWindows)`, so it does not read as a duplicate of the line
beneath it and survives a reviewer who has just fixed the obvious one. And
a grep for `claude` in that file returns **nine** hits, of which only three are
defects (the two path literals and the `claude --help` text). The other six must
not be touched: `color="claude"` is a **theme colour name** and appears on five
JSX lines, and `tengu_claude_install_command` is an **analytics event name**,
where a rename silently breaks continuity with historical data rather than
failing loudly. Counts verified by running the grep, not estimated.

**How to apply:** treat this as open until the lead decides between removing the
command, repointing the source, or gating it — it is a command-lifecycle
decision, not a patch. Related and separate: the fork has no working auto-update
path at all, because `MACRO.PACKAGE_URL` is `axa-chat`, which is unpublished, so
`npm view` 404s and `AutoUpdater` never proceeds. Also note the command's own
`--help` description claims it installs this product, which is false.
