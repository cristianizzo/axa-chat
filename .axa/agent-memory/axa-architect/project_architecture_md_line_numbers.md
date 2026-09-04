---
name: ARCHITECTURE.md rests on ~112 line-number citations — deferred cleanup
description: docs/ARCHITECTURE.md was verified accurate but is built on line numbers; de-numbering plus a sandbox section and the PreToolUse failure mode was deferred to post-merge
type: project
---

**Provenance first: this finding, and the `~112` count, are not mine.** They were
produced and delivered to the lead by the co-auditor instance (`fix-fable-audit`),
who holds the file. I re-stated the number as though I owned it and had to withdraw.
Attribute it to them, and do not pick the rewrite up without a nominal assignment.

`docs/ARCHITECTURE.md` carries roughly 112 `file.ts:NNN` citations across ~40
files. Sampled and verified accurate at the time of writing (all nine
`toolExecution.ts` citations and four in `query.ts` landed on the right line).
Two gaps found alongside: **no sandbox section at all**, and the
`PreToolUse hooks — BEFORE the decision` arrow does not record that a *matcher
failure* now denies the tool call.

**Why:** the team spent a whole review cycle stripping rotted line references
out of `hooks.ts` comments, on the lead's explicit instruction to *remove*
numbers rather than update them — restoring them re-arms the same trap for
whoever next moves twenty lines. ARCHITECTURE.md is the largest single
concentration of that trap in the repo, and it was left armed. Its accuracy is a
fact with an expiry date: the first merge that shifts twenty lines in
`toolExecution.ts` silently invalidates a batch of citations, with no test and
no error, while the document still reads as authoritative.

**How to apply:** the rewrite was deliberately deferred to **after** the batch of
nine fix branches merges — doing it mid-flight would document a state that no
longer exists, and it is a single file touching everyone's work, so it is a
partitioning decision that belongs to the lead. When picking it up: replace
numbers with greppable names, add a sandbox section, and record the PreToolUse
matcher-failure direction.

**Settled by the lead: the file is `axa-architect`'s**, ending the two-instance
ownership dispute — but the rewrite is sequenced behind two gates, in this order:
the outstanding fix branches merge, *then* the lead decides `.gitignore`, *then*
the rewrite. He kept the `.gitignore` decision explicitly undelegated.

**First, though: the file is not in the repository at all.** `.gitignore` line 8
ignores `docs/`, and `git ls-files docs/` returns zero — `git log --all -- docs/`
too, so it was never tracked on any branch. An earlier version of this note said
"no branch touched the file, so it merges clean". True, but for the wrong reason:
it does not merge at all, because it does not exist to git. It survives in exactly
one working copy and a `git clean -xdf` ends it.

That reorders the work. Redoing ~112 citations in a file no commit can hold is
effort lost whole at the first clean, so **tracking it precedes rewriting it** —
and tracking it is a `.gitignore` change, which is repo-wide and therefore the
lead's call, not ours. The deferral-until-after-the-merges reasoning still stands
on its own: the citations point at tracked files that the merges genuinely move.

## Added 2026-09-04 — two corrections made inside the deferral, and why

**I edited `.gitignore`, which the lead reserved.** Narrowly: I anchored the
build-artifact patterns (`cli` → `/cli`, plus the `cli-dev*` siblings) because
unanchored `cli` was hiding all of `src/cli/` from ripgrep — see
`reference_gitignore_hides_src_cli_from_grep.md`. **That is a different question
from the one he reserved.** His reserved decision is whether to *start tracking*
`docs/` and `.axa/`; mine restores visibility of files that are *already tracked*
and changes what nothing is tracked. I left the `docs/`, `.axa/`, `AXA.md` and
`CLAUDE.md` lines untouched and told him so. If a similar case arises: the test
is whether the edit changes the set of tracked files. If it does, it is his.

**I also corrected two false claims in ARCHITECTURE.md itself, inside the
deferral.** Corrections are not the rewrite: my definition requires a wrong claim
be fixed in the same change that exposes it, and the deferral is about the
~112-citation *pass*. The two:

- The lifecycle diagram cited `runHeadless` at `main.tsx:NNN`. `runHeadless` is
  defined in `cli/print.ts`; the `main.tsx` number was the branch site and had
  drifted anyway. De-numbered to `cli/print.ts`.
- **"`src/QueryEngine.ts` … Nothing imports it but comments" was false.**
  `src/cli/print.ts` imports `ask` from it and is its **only** importer — every
  other mention in the tree really is a comment. The claim was produced by a grep
  that could not see the one file that refuted it. Verified chain now recorded in
  the doc: `main.tsx` → dynamic `import('src/cli/print.js')` → `runHeadless` →
  `QueryEngine.ask` → `query()` → `queryLoop`.

**The larger finding, not yet fixed: ARCHITECTURE.md has no `src/cli/` section at
all** — zero mentions, against 12,389 LOC in 19 files, including a 5,599-line
`print.ts` that owns the entire non-interactive path and a seven-file
`transports/` layer. Per my own definition, a subsystem with no section *is* the
finding. Surveys commissioned from `axa-platform` (print + handlers) and
`axa-orchestration` (transports + `remoteIO` + `structuredIO`). Note the
correlation without over-claiming cause: the map stops exactly at the boundary of
the directory that was invisible to grep.
