---
name: A green check counts only once it has been shown able to fail
description: On macOS several verification commands fail silently and print a perfect pass; always report the evidence the check actually ran, not just its negative result.
type: feedback
---

Never report "zero errors", "no diff", or "comment-only" on the strength of an
empty result. Report the negative result *and* the evidence the check ran: a
line count, a control case that comes back non-empty, an injected failure the
comparison detects.

**Why:** on macOS several checks fail silently rather than erroring, and every
one of them prints a flawless pass.

- `tac` does not exist. A patch-id comparison wrote two empty files and `diff`
  passed triumphantly — a vacuous proof that a rebase had moved no content.
- `timeout` does not exist. `timeout 560 bunx tsc --noEmit | grep -c 'error TS'`
  prints `0` because tsc never started.
- **`git show "$sha:src/..."` in zsh corrupts the pathspec, and quoting does
  not save you — only `${sha}` does.** zsh applies a history modifier when `:`
  is followed by one of its modifier letters, *inside double quotes too*. The
  cause is the letter after the colon, not the quoting, and the common repo
  prefixes are the worst offenders (measured with `v=abc`):

  | written | expands to | why |
  |---|---|---|
  | `"$v:hooks/x"` | `.ooks/x` | `:h` head — **silent** |
  | `"$v:tools/x"` | `abcools/x` | `:t` tail — **silent** |
  | `"$v:utils/x"` | `ABCtils/x` | `:u` upcase — **silent** |
  | `"$v:src/..."` | `abc`, or `bad substitution` | `:s` substitute |
  | `"$v:path"`, `"$v:main.ts"` | intact | `p`/`m` aren't modifiers |
  | `"${v}:anything"` | intact | **the fix** |

  So `git show "$s:src/..."` runs `git show <sha>` and prints the commit
  message and diff instead of the blob — the check runs, exits 0, and is
  pointed at the wrong object. Always brace: `git show "${sha}:path"`.
- `${PIPESTATUS[0]}` is a bash-ism; this shell is zsh, where it is
  `$pipestatus`. An exit-code check written the bash way prints an empty
  string, so a pipeline whose status you never learned looks like one you did.
  This one is comparatively benign — blank announces itself — which is exactly
  why the others on this list are the dangerous ones.

- **`Grep`/`rg` honour `.gitignore`, so an ignore rule silently deletes files
  from every search.** `.gitignore` carried an unanchored `cli`, and a pattern
  with no slash matches at *any* depth — so it matched the root build artifact
  **and the tracked source directory `src/cli/`**. Git itself never complained,
  because ignore rules don't apply to already-tracked files. Ripgrep applies
  them anyway. 19 tracked source files — `cli/update.ts`, all of
  `cli/handlers/`, all of `cli/transports/` — were invisible to every recursive
  search any of us ran, with no error and no warning. Three people
  independently concluded `installLatest` had "exactly two callers"; it has
  three, and the third is the one that answers the reachability question.

An empty result from a dead command and an empty result from a real one are
indistinguishable.

**Coverage check, once per session, before trusting any negative:**

```
comm -23 <(git ls-files | sort) <(rg --files | sort)
```

Should be empty apart from dotfiles (rg skips those). When searching for a
*negative* — "X appears nowhere", "only N callers" — prefer `git grep`, which
searches tracked files and ignores `.gitignore` entirely. Note the double
concealment in the case above: the file was hidden from a directory search
*and* imported under an alias (`installLatest as installLatestNative`), so a
search for `installLatest(` would have missed it even had it been visible. Two
independent causes of one false negative is why several people converged on the
same wrong answer rather than one person getting it wrong.

Run the coverage check **per checkout**. A `.gitignore` fix applied in the main
checkout does not reach an existing worktree until it lands on `main` and that
worktree rebases, so a worktree stays blind after the bug is "fixed".

**How to apply:** pair every negative result with its proof of life. Comment-only
claims: strip comment lines from `git diff -U0`, show nothing remains *and* show
the strip matched N lines, *and* run the same filter on a known code commit so
it reports a positive. Typecheck by diff: inject a fabricated error line and
confirm the comparison surfaces it before trusting an empty "added" list.

Two corollaries, both learned the hard way:

- The control-that-must-fail proves the tool can report a positive. It does
  **not** prove the tool was aimed at the thing you named.
- When two verifications of the same question disagree, one of them is broken.
  Find which. Do not average them, and do not report the contradiction as a
  finding until you know which side is the instrument.
- When a *tool* is found to have been lying, re-derive the claims it touched
  even on branches already signed off. Sweeping after the `.gitignore` find
  turned up a shipped comment of mine asserting "timedOut has a single reader"
  when there were two — a claim the hidden subtree had nothing to do with, and
  which a working grep would have caught at any point. The sweep's value was
  forcing re-derivation, not the corrupted results it was aimed at. Budget for
  finding defects unrelated to the one that prompted the sweep.

Related and already recorded separately: verifying that a push landed, and the
rule that an approval binds to a SHA rather than a branch — see
`feedback_verify_push_with_ls_remote.md`.
