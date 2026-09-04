---
name: Typecheck verification traps in this repo
description: How to actually verify a branch here — tsc baseline is 1441, missing macOS commands fake a pass, zsh history modifiers silently eat a pathspec even inside double quotes (braces are the only fix), and every check needs a control that must fail
type: reference
---

There is **no `typecheck` script** in `package.json`. Use `bunx tsc --noEmit` and count
with `grep -c 'error TS'`. The repo does **not** typecheck clean.

**Baseline on `main`: 1441 errors.** A branch is clean when its total is also 1441.
There is exactly one `tsconfig.json`, so `-p .` is a no-op — it also gives 1441.
The figure survived main moving from `65ae3eb` to `e68fd37`, so it is stable.
Counts of **1721** and **1503** also circulated. Neither is reproducible from any
invocation: the variable is the **tree**, not the flags — a stale, dirty or
`node_modules`-less worktree inflates the total with TS2307s. Regenerate in the
same worktree when in doubt.

Note carefully what that does and does not invalidate. The 1721 was a *diff*
measurement with the baseline regenerated inside that same worktree — 1721 on
both sides, delta zero — so the verdict built on it was sound even though the
absolute figure travels nowhere. **Only the delta is meaningful; an absolute
total quoted across worktrees means nothing.** Separately, an advancing `main`
un-proves any baseline taken before it, even when re-measuring returns the same
number — "unchanged" and "still proved" are different claims.
A looser `grep -c error` gives 1474 — always match `error TS`.

Three traps, each of which has produced a wrong verdict here:

1. **`timeout` does not exist on macOS/zsh.** Wrapping the command
   (`timeout 560 bunx tsc --noEmit`) dies with `command not found` *before* tsc runs,
   and a downstream `grep -c` then reports **0 errors** — a perfect-looking pass
   meaning the check never happened. Treat any result of 0 as a failed run, not a
   success.

2. **An error in a changed file is not automatically a delta.** `src/types/message.ts`
   does not exist while dozens of files import `types/message.js`, so touching almost
   any file can surface a pre-existing TS2307 that looks newly introduced. Adding one
   import line shifts the reported line number, which makes it look fresher still.
   Check the total first; if it is unchanged, the error is pre-existing.

3. **tsc cannot see inside strings, and unused code passes.** It also cannot see
   inside *comments*, which gives the same bug a mirror image: `${CONFIG_DIR_NAME}`
   typed into a JSDoc block renders as the literal text `${CONFIG_DIR_NAME}`,
   because `${}` is only meaningful inside a backtick literal. Both directions —
   an escaped interpolation in a template literal, and a bare interpolation in a
   comment — compile perfectly. `noUnusedLocals` is off,
   and there is **no eslint config at the repo root and no lint script** — which means
   every `// eslint-disable-next-line custom-rules/...` comment in the tree is inert,
   a claim about a rule nobody enforces. So a dead import survives, and — the expensive one —
   an escaped interpolation (`` \`\${X}\` `` inside a template literal) renders the
   literal text `${X}` into a model-facing prompt while scoring a perfect 1441.

**The general rule these are all instances of: pair every check with a control
that must fail.** An empty diff, a zero count and a dead command are the same
observation. Before accepting a negative result, produce a positive one from the
same machinery — measure `git diff main <branch>` before believing
`git diff <old> <new>` is 0 bytes; count the lines of a generated list before
believing two such lists are identical. This has already caught a `timeout`
non-existence here, and `fix-m4` independently hit the identical shape with
`tac` (also absent on macOS) while proving a force-push: both sides emitted
empty files, `diff` compared nothing to nothing, and it read as a pass.

**An unexplained discrepancy between two reviewers' counts is an unrecognised
finding, not noise.** The lead measured 546 files carrying an inline sourcemap;
I measured 548, asserted mine, and we both let the gap go as a counting
difference. It was `.gitignore`'s unanchored `cli` pattern hiding `src/cli/`
from ripgrep — `git grep` sees tracked files regardless, `rg` does not — and the
two missing files were `cli/handlers/mcp.tsx` and `util.tsx`. The bug had been
producing visible reviewer disagreements for two days and we absorbed them.
**Being right is what made it invisible:** a correct number ends the
conversation, so the wrong one never gets explained. When two measurements of
the same set differ, reconcile the *difference* before defending your own —
name the specific elements in the gap, not the totals. See
`reference_gitignore_hides_src_cli_from_grep.md` (audit-2's) for the mechanism.

**The shell can silently change what you measured.** In **zsh**,
`git show $s:src/utils/x.ts` does not read the blob — the pathspec is mangled or
deleted, and `git show <commit>` runs instead, returning the commit message plus
a diff. Hashing that "blob" therefore compares commit *messages*, so a
message-only or comment-only commit reports as a content difference. This
produced a live false alarm here: a comment-only commit on
`fix/hook-timeout-failopen` appeared to change code because the two hashes
differed, while the line-level filter on the same diff correctly reported zero
non-comment lines.

**The cause is not "unquoted" — this entry said so and was wrong.** `fix-m4`
quoted it properly and was bitten anyway. zsh applies a **history modifier**
whenever `$var:` is followed by a modifier letter, and **double quotes do not
suppress it**. The trigger is the letter, not the quoting. Measured here with
`v=abc` under zsh 5.9:

| written | expands to | |
|---|---|---|
| `"$v:hooks/x"` | `.ooks/x` | `:h` head — **silent** |
| `"$v:tools/x"` | `abcools/x` | `:t` tail — **silent** |
| `"$v:utils/x"` | `ABCtils/x` | `:u` upcase — **silent** |
| `"$v:src/..."` | `abc` / `bad substitution` | `:s` substitute |
| `"$v:path"`, `"$v:main.ts"` | intact | `p`/`m` are not modifiers |
| `"${v}:anything"` | intact | **the fix** |

`src/`, `hooks/`, `tools/`, `utils/` are four of the commonest directory roots in
this repo and three corrupt **silently** — exit 0, no warning, and a
`fatal: path does not exist` that reads like a real answer about the tree. Only
`:s` is loud, and that is the one I happened to hit. **Always brace it:
`git show "${s}:path"`.** Quoting is not the fix and believing it is leaves you
exposed while feeling covered.

The general lesson is the one above rotated: a control proves your instrument can
report a positive, but it does not prove the instrument was pointed at the thing
you named. When two checks of the same question disagree, the bug is in a check —
find which, do not average them. And when you record a trap, record the
*mechanism*: a memory naming the wrong cause is worse than none, because the fix
it implies is the one that does not work.

**Also know what a proof is structurally blind to.** `git patch-id` ignores
commit messages by construction, so on a message-only rewrite — the exact case
it gets used for — the strongest available proof cannot see the change. Verify
that half separately (`git log -1 --format=%B <c> | shasum`, pairwise old vs
new). Same idea as tsc not seeing inside strings: pick the second instrument for
what the first is definitionally unable to observe, not for redundancy.

**How to apply:** for any branch touching prompts, `.describe()` text, or user-facing
strings, the typecheck delta is not evidence. Render the string (`bun -e`) and read
what the model would actually receive. Then apply the scope check: grep for the same
text elsewhere, and look for a *correct sibling* nearby — a neighbouring file that got
it right is what proves the bad one was a slip rather than a deliberate choice.
