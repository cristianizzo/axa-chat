---
name: A clean negative may be a command that never looked
description: rg silently skips .gitignore'd paths (src/cli was ignored by an unanchored `cli` pattern), zsh aborts on an unquoted glob and rewrites `"$sha:src/..."` via history modifiers, aliased imports defeat name searches — all produce output that reads as proof of absence.
type: feedback
---

**Positives are trustworthy; negatives are not.** "X appears nowhere", "only N
callers", "no other instance" — each of those is a claim about a search having
*looked*, and several mechanisms in this repo produce empty output from a search
that never did.

Known members of the family:

- **Ripgrep honours `.gitignore`.** An unanchored pattern (`cli`, no leading
  slash) matches a directory of that name **at any depth**, so `src/cli/` was
  ignored and `rg`/the `Grep` tool skipped 19 tracked source files — all of
  `src/cli/handlers/` and `src/cli/transports/` included. Git never complained,
  because ignore rules don't apply to already-tracked files. Use `git grep`,
  which ignores the ignore file for tracked paths.
- **zsh aborts the whole command on an unmatched glob.** `grep -rn X src/
  --include=*.ts` → `no matches found`, the command never runs, and the output is
  indistinguishable from a real empty result. Quote the pattern.
- **Aliased imports defeat name searches** even in fully visible files:
  `import { installLatest as installLatestNative }` is invisible to a search for
  `installLatest(`. This one is independent of the other two.
- **zsh history modifiers eat `$var:path`, and quoting does not help.** When a
  `$var` is followed by `:` and a modifier letter, zsh expands it *inside double
  quotes*: `"$sha:hooks/x"` → `.ooks/x` (`:h`), `"$sha:tools/x"` → `<sha>ools/x`
  (`:t`), `"$sha:utils/x"` → `<SHA>tils/x` (`:u`). `:s` (both `src/` and
  `services/`) is a substitution whose delimiter is the next character, so it
  errors only when no second `r` closes it — `"$sha:src/foo.ts"` fails loudly,
  but `"$sha:src/utils/bar.ts"` silently yields `<sha>`. At real path depth the
  silent branch is the common one, so "at least `src/` fails loudly" is a wrong
  lesson drawn from a correct observation. The fix is **braces, not quotes**:
  `git show "${sha}:path"`. Unbraced, `git show "$sha:src/…"` degrades to
  `git show <sha>` and prints a commit message — so a blob comparison silently
  becomes a commit-message comparison and "no difference" is vacuous.
- Previously seen in the same family: a dead `timeout`, a missing `tac`,
  `${PIPESTATUS[0]}` (zsh uses `$pipestatus`).

**Why this bites specifically here:** several agents independently concluded
`installLatest` had "exactly two callers" and reasoned about reachability from
that closed set. There are three. The third was concealed *twice* — invisible
file **and** aliased import — which is why the wrong answer looked corroborated
rather than isolated. Convergence between agents is not evidence when they share
a tool.

**How to apply:**
- Once per session, verify the search tool can see the tree:
  `comm -23 <(git ls-files | sort) <(rg --files | sort)` should be empty apart
  from dotfiles.
- Before asserting a negative, prove the command looked — non-empty output on a
  deliberately-matching control, or use `git grep`.
- Never publish a count or an exclusion list produced by a filtered search.
