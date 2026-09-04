---
name: Typecheck by normalized diff, with a self-generated baseline
description: This repo has ~1400 pre-existing tsc errors; judge a change by an empty normalized diff, and always regenerate the baseline yourself with the identical command.
type: feedback
---

Never judge a change by tsc error **count**. Generate a baseline from `origin/main` in your own worktree, then diff normalized output:

```
norm() { sed -E 's/\(([0-9]+),([0-9]+)\)/(L,C)/' "$1" | sort; }
diff <(norm base.txt) <(norm after.txt)
```

Target is an empty diff.

**Why:** there is no `typecheck` script — `bunx tsc --noEmit -p .` is the invocation. A baseline produced by any other invocation gives a different total (1721 vs 1441 was observed for exactly this reason) and a count comparison against it is meaningless. Line/column normalization is needed because any edit shifts positions in untouched pre-existing errors.

There is exactly one `tsconfig.json`, so `-p .` is a no-op and the flag is never the variable — the **tree** is. In one multi-agent session three different totals circulated (1721, 1503, 1441) while everyone reported "delta zero". None of the measurements was wrong and none of the verdicts built on them fell: they were three checkouts. The defect was quoting an *absolute* next to a delta as if it corroborated it — a number that looks corroborating but isn't comparable is worse than no number, because it moves confidence without carrying information.

**Hazard in the procedure itself:** regenerating the baseline requires detaching HEAD (`git checkout --detach origin/main`), and a worktree left detached breaks pushing *silently* — `git push origin <branch>` resolves the name as the local branch ref, not as HEAD, so it reports "Everything up-to-date" and the new commit stays orphaned. `git rev-parse HEAD` does not reveal this. Check with `git symbolic-ref -q HEAD` and confirm publication with `git ls-remote`, never with an exit code.

**How to apply:** before every commit. Generate the baseline **in the same worktree at the same moment** as the branch measurement, and treat only the delta as meaningful. Inherited /tmp baselines from earlier sessions or other agents are not trustworthy. `git stash` + `git checkout --detach origin/main` + run + restore is safe and keeps `node_modules` warm.
