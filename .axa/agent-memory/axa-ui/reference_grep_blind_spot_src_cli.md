---
name: Recursive grep can be blind to tracked files — verify coverage before trusting a negative
description: An unanchored .gitignore entry made all of src/cli invisible to ripgrep while staying tracked in git; use git grep for negatives and check coverage once per session.
type: reference
---

`.gitignore` had an unanchored `cli` entry, which matches a file *or directory of that name at any depth* — so it caught the root build artifact **and** the tracked source directory `src/cli/`. Git ignores ignore-rules for already-tracked files, so `git ls-files` listed them; ripgrep applies them regardless, so `Grep`/`rg` silently skipped all 19 files. No error, no warning.

**How to apply:**
- Check coverage once per session: `comm -23 <(git ls-files | sort) <(rg --files | sort)` should be empty apart from dotfiles.
- For any claim of the form "X appears nowhere", "only N callers", "no other instance", use **`git grep`** — it reads tracked files and does not consult `.gitignore`. Positives from `rg` are still trustworthy; only negatives were ever at risk.
- Note `.axa/` and `docs/` are also gitignored, so `git grep` will not see them either — including agent-memory and `docs/ARCHITECTURE.md`.

**Why it matters for this area specifically:** `src/cli/handlers/util.tsx` and `mcp.tsx` mount `AppStateProvider` + `KeybindingSetup` and call `root.render(...)` directly, which makes them provider-mounting sites *outside* `interactiveHelpers.tsx`. Any check of the "only one mount site / providers can't be nested" claim that greps for `AppStateProvider` under `src/` will miss them and reach a falsely clean answer.

Reusable lesson: this false negative had **two independent causes** (invisible file *and* an aliased import, `installLatest as installLatestNative`). Fixing one would not have surfaced it, and because several people hit it separately it looked like consensus.
