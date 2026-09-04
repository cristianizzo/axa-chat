---
name: Never pre-label an expected-empty result
description: Don't write "(empty above = confirmed)" into a command; an echo can't know whether the preceding stage ran, so every failure mode renders as success.
type: feedback
---

Do not embed the interpretation of a result in the command that produces it — no `echo "(empty above = clean)"` after a pipeline whose emptiness is the evidence. Print the raw output and read it, or print a **count** and check two numbers agree.

**Why:** verifying a diff was comment-only, I piped added lines through `cat -A` (GNU-only; BSD `cat` on macOS rejects it). The stage errored, emitted nothing, and my pre-written label directly underneath announced the empty output as confirmation. A pre-written "(empty = good)" converts *every* failure — bad flag, missing binary, wrong path, shell mangling — into a success message.

**How to apply:** whenever the evidence for a claim is an absence. This is the same family as `tac`/`timeout`/`cat -A` not existing on macOS, `rg` blinded by `.gitignore`, and zsh history-modifier expansion in `git show "$sha:src/..."` (brace it: `"${sha}:path"`). In all of them the command exits 0 having measured nothing. The aggravating factor here is self-inflicted: the misreading was authored before the command ran.

Corollary: a negative reported by someone else is not measured until you measure it. Re-derive it rather than repeating it.
