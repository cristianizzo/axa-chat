---
name: Verification commands that exit 0 without measuring anything
description: rg is blind to docs/ and .axa/ (unanchored gitignore) so negatives need --no-ignore; and zsh mangles "$sha:src/..." unless braced. Both fail silently at exit 0.
type: reference
---

`.gitignore` carries unanchored `docs/` and `.axa/` patterns. Ripgrep honours
gitignore, so **every recursive `rg`/`Grep` silently skips those directories**,
including `docs/ARCHITECTURE.md`, `docs/ANALYSIS.md` and all agent definitions.

**Why:** an unanchored pattern matches at any depth. The same defect once hid
the tracked `src/cli/` subtree (fixed by anchoring `cli` → `/cli`), but `docs/`
and `.axa/` are *untracked as well as ignored*, which makes them worse.

**How to apply:** before asserting any negative ("no `.md` references X", "this
claim appears nowhere"), re-run with `rg --no-ignore`. The
`comm -23 <(git ls-files|sort) <(rg --files|sort)` coverage check does **not**
catch this — untracked paths never appear in `git ls-files`, so the diff is
empty even while rg is blind. Use `comm` for tracked-but-invisible files and
`--no-ignore` whenever the negative concerns `docs/` or `.axa/`.

Cost so far: I asserted "no `.md` in the repo references these model IDs" in a
PR body and it was false — `docs/ARCHITECTURE.md` cites `deepseek-v4-flash` for
`catalog.smallFastModel`. A co-auditor independently made the same false claim,
naming ARCHITECTURE.md as checked. Positives stay trustworthy; only negatives
were corrupted.

## Always brace `git show "${sha}:path"`

zsh applies history modifiers when `$var:` is followed by a modifier letter —
**double quotes do not protect you**; only braces do. Reproduced with `v=abc`:
`"$v:hooks/x"` → `.ooks/x` (`:h`), `"$v:tools/x"` → `abcools/x` (`:t`),
`"$v:utils/x"` → `ABCtils/x` (`:u`). Those three are silent. `:s` (`src/`) is
loud here — `git show "$sha:src/foo.ts"` became `938308d.ts` and errored — but
`hooks/`, `tools/` and `utils/` corrupt with no error, turning a blob comparison
into a commit-message comparison whose "no difference" is vacuous.

Related: `cmd | head` reports *head's* exit status, not the command's. Use
`$pipestatus` in zsh (not `${PIPESTATUS[0]}`) when the real status matters.
