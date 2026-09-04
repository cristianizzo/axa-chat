---
name: Source auto-update invariants and known holes
description: Trust-boundary invariants for the background source updater (sourceUpdate.ts / scripts/update.ts / scripts/source.ts / install.sh) and open findings from the 2026-08-24 audits, to re-check for regressions.
type: project
---

axa auto-updates itself by rebuilding its own source tree, so the updater's guards are the security boundary. Audited twice on `feat/auto-update-staged` (2026-08-24).

Invariants that must hold (re-verify on any change to the updater):
1. A developer's working checkout is never touched unattended. Guard chain: `isInBundledMode()` + binary named `cli-dev` at the source root + `isInstallerManaged()` (`.axa-install.json`) + `isUnattendedUpdateSafe()` (clean `git status --porcelain`, non-detached HEAD, configured upstream, not ahead).
2. The running binary is only ever replaced by `rename(2)`, never built over. `bun build --outfile` truncates in place.
3. Any "is this our tree" test must be axa-specific (package.json + scripts/build.ts + src/entrypoints/cli.tsx); "package.json + .git" matches every JS project.
4. `repo`/`ref` from `.axa-install.json` are interpolated into GitHub URLs — validate with `REPO_PATTERN`/`REF_PATTERN` + `..` reject at every reader.
5. NEW: the marker's `repo` must never be able to name a third-party GitHub repo. The regexes only constrain *shape*; `evil/axa-chat` passes.

Fixed in round 1, do not re-report: findRepoDir accepting any `.git` dir; the `~/.local/bin/axa` symlink fallback; the TOCTOU between the safety check and the lock. Deliberately accepted: unhardened `tar -xz`; the git marker's `commit` is never refreshed.

Open findings from round 2 (2026-08-24):
- The **source tree itself is the trust boundary** and nothing verifies it. Any single-file write inside it becomes unattended RCE via `bun run update:staged` (package.json scripts, `scripts/update.ts`, `bun install` lifecycle scripts, `.git/config` `core.fsmonitor`, `.git/hooks/*`). `git status` cannot see `.git/**`, gitignored files, or node_modules; tarball installs have no status check at all.
- Marker poisoning: `.axa-install.json` `repo` accepts any owner/name, and a `source:"tarball"` marker overrides a git checkout in `scripts/update.ts` (findInstallRoot runs before the git path). `.axa-update.json` `builtSha` can be set to force an immediate rebuild.
- `walkUpToRepoRoot` is applied to the `$HOME/axa-chat` candidate in `findRepoDir`, so `/update` can retarget `$HOME`.
- No signature/provenance on downloaded source; a force-push or account compromise upstream reaches every user within 24h, and `autoUpdate` defaults to true.
- `applyStagedBinary`/the `--outfile` tmp path do no `lstat`/`O_NOFOLLOW` check, so `cli-dev.next` symlink planting matters in a group-writable tree.

**Why:** the marker/guard design was added after a review found "a cli-dev next to a package.json in a git repo" matched every dev checkout; round 2 showed the remaining gap is that the guards authenticate the *location*, never the *content*.
**How to apply:** when reviewing `src/utils/sourceUpdate.ts`, `scripts/update.ts`, `scripts/source.ts`, `scripts/build.ts`, `src/commands/update/update.ts` or `install.sh`, walk these five invariants before looking at anything else.
