---
name: An unanchored .gitignore line hid all 19 files under src/cli from every ripgrep search
description: `.gitignore:3` was `cli`, which matches src/cli/ as well as the root build artifact; git tolerated it because the files are tracked, ripgrep did not, so Grep silently omitted 19 source files repo-wide
type: reference
---

**Fixed 2026-09-04** by anchoring the build-artifact lines (`cli` → `/cli`, and
the three `cli-dev*` siblings for the same latent reason). Keep this note anyway:
the *class* outlives the instance, and the fix is one line that anyone could undo
by re-adding an unanchored name.

## What happened

`.gitignore` line 3 was `cli`. A gitignore pattern with no slash matches a file
**or directory of that name at any depth**, so it matched the intended root build
artifact *and* the source directory `src/cli/`.

Git never complained, because ignore rules do not apply to already-tracked files —
`git ls-files src/cli` returned all 19. **Ripgrep applies them anyway**, so every
recursive `rg`/`Grep` over `src/` silently skipped the whole subtree:

- `src/cli/update.ts`, `print.ts`, `exit.ts`, `remoteIO.ts`, `structuredIO.ts`,
  `ndjsonSafeStringify.ts`
- `src/cli/handlers/` — `util.tsx`, `mcp.tsx`, `auth.ts`, `agents.ts`,
  `plugins.ts`, `autoMode.ts`
- all seven of `src/cli/transports/`

Measured: `comm` of `git ls-files` against `rg --files` gave **exactly 20**
tracked-but-invisible paths — those 19 plus `.gitignore` itself, which is hidden
for the unrelated and expected reason that rg skips dotfiles. After the fix the
same comparison leaves only `.gitignore`.

## Why it is worse than a missing file

**A blind spot in the search tool converts into a confident false negative in a
review.** It cost a real finding: three of us independently concluded
`installLatest` had "exactly two callers" and reasoned about reachability from
that closed set. There are **three** — `cli/update.ts` imports it as
`installLatest as installLatestNative` and calls it behind
`diagnostic.installationType === 'native'`. `fix-fable-audit` found it; I had
asserted the closed set to the lead and to two implementers, and had written it
into memory. My grep was not wrong about what it saw; it was wrong about what it
had looked at.

The subtree it hid is not incidental. `cli/handlers/util.tsx` is the middle link
of the `axa install` chain
(`project_native_updater_points_at_upstream.md`) — a file we were all citing and
none of us could grep. `cli/transports/` is the entire SSE/WebSocket transport
layer. Any prior claim of the form "X appears nowhere in the codebase", made by
any agent in this repo before this date, was measured against a tree with those
19 files removed.

## How to apply

- **Anchor build artifacts in `.gitignore`.** A bare name is a repo-wide pattern.
- Treat *any* empty grep result as a claim about coverage, not about the code.
  Cheapest guard: `comm -23 <(git ls-files) <(rg --files)` should be empty modulo
  dotfiles. Run it once per session before relying on a negative.
- Related but **not** fixed, and possibly deliberate: `.gitignore` also carries
  unanchored `AXA.md` and `CLAUDE.md`, plus `docs/` and `.axa/`. Consequence —
  `git ls-files .axa docs` returns **0**. So `docs/ARCHITECTURE.md`, the agent
  definitions and this agent-memory directory are **not in version control**,
  which contradicts the standing description of agent-memory as "shared with your
  team via version control". Raised with the lead; do not change it unilaterally,
  it may be intentional for a fork that does not want to ship its own config.
