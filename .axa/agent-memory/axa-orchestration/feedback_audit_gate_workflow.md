---
name: Audit gate workflow for fix branches
description: How fix branches get reviewed in this repo — signature is on an SHA, audit the remote ref, typecheck delta must be same-tree, false positives are a valid outcome.
type: feedback
---

Fix branches in this repo go through an audit teammate before a PR is opened, and
the flow is: implement → typecheck by diff → commit + push → request audit →
wait for APPROVED → open PR → report to lead. Merging is never the implementer's
to take; it is the lead's, and it stays frozen until the Copilot round closes on
all PRs.

**Why:** the lead treats an unaudited escrito-style claim as unsafe — this repo
has a documented history of comments that were checkable and wrong, so every
claim in a commit message or code comment is expected to be verified against
source and gets checked one by one at the gate.

**How to apply:**
- **The signature is on an SHA, not on a branch.** Any further push lapses it.
  Before pushing or requesting a re-audit, run `git symbolic-ref -q HEAD` and
  `git ls-remote --heads origin <branch>` — measuring a typecheck baseline is
  itself a detaching operation, and `git rev-parse HEAD` will not reveal a push
  that republished an old commit and orphaned the new one.
- **Audit `origin/<branch>` after `git fetch`, never the local ref.** A stale
  remote-tracking ref blocked the same branch twice on work that was already
  pushed.
- **Typecheck delta must be measured on both sides in the same worktree.** An
  absolute error total quoted across worktrees means nothing; only the same-tree
  delta does. Target is zero.
- **A false positive is a valid outcome** and is worth more than a confirmed
  finding. Write it as "the finding as formulated is false, here is the citation,
  and here is what is actually broken underneath" — never reword it so the
  original report looks right.
- **Nothing ships as a known issue.** Fix it, or state in the PR body why it is
  out of scope, with file, line and the reason for the exclusion.
- **Sweep by pattern, not by the symbol the finding names.** A report naming one
  function makes it easy to grep that name, find every caller, and conclude the
  fix is complete — while a sibling site does the same unsafe thing through a
  different function. This is a *correct negative to the wrong question*, and no
  coverage check catches it: the grep was clean, the question was narrow.
- **In zsh, `"$sha:src/..."` is mangled by history modifiers even when quoted** —
  `:s`, `:h`, `:t`, `:u` all fire on the letter after the colon, so `src/`,
  `hooks/`, `tools/` and `utils/` corrupt silently and still exit 0. Always brace:
  `git show "${sha}:path"`. A literal ref (`git show abc123:src/x.ts`) is safe,
  since the trigger is parameter expansion.
- **`.gitignore` in this repo has silently hidden tracked source from ripgrep.**
  Ignore rules do not apply to already-tracked files, so `git ls-files` sees them
  and `rg`/`Grep` do not. When a negative result matters, use `git grep` (reads
  the index) and sanity-check coverage with
  `comm -23 <(git ls-files | sort) <(rg --files | sort)` — it should be empty
  apart from dotfiles.
- The gate cannot see unused imports or dead code: there is no lint script and
  `noUnusedLocals` is off, so a dead import scores a perfect typecheck delta
  forever. That class has to be read, not measured.
- Apply a dead-code rule to the *whole* diff or not at all — deleting one
  orphaned function while keeping another orphaned by the same change leaves two
  contradictory precedents.
