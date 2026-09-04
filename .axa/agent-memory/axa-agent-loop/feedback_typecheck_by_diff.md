---
name: Verify changes by typecheck diff, never by error count
description: There is no `bun run typecheck` script; use tsc directly and compare a self-generated baseline from origin/main in the same worktree — never a /tmp baseline or a raw count.
type: feedback
---

Verify a change with `./node_modules/.bin/tsc --noEmit -p tsconfig.json` and compare
against a baseline generated **from `origin/main` in the same worktree**, normalizing
away line/column drift:

```
norm() { sed -E 's/\(([0-9]+),([0-9]+)\)/(L,C)/' "$1" | sort; }
```

Target is **zero delta**, not a matching total.

**Why:** the repo carries a large number of pre-existing type errors (~1721 at the
time of writing), so a raw count says nothing and drifts as main moves. Baselines
left in `/tmp` from earlier sessions go stale and carry absolute paths from a
different worktree, producing a fake delta. There is also no `typecheck` package
script — `bun run typecheck` fails with "Script not found"; the scripts are build,
build:dev, build:dev:full, compile, dev, update, update:staged.

**How to apply:** regenerate the baseline yourself each time, in the worktree you
are working in. Never trust a stored baseline, never report "N errors, same as
before" as evidence.
