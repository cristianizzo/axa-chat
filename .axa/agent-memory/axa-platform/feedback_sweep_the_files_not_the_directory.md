---
name: A sweep that covers a directory has not covered its files
description: Twice on one branch, a fix landed in a subdirectory while the same defect survived in the parent file or a sibling one directory over — the tree looked handled precisely because part of it was.
type: feedback
---

When sweeping a defect class across the repo, enumerate the **files** the sweep
matched, not the directories it visited. A directory that has been touched reads
as done, and that impression is what protects the file inside it you never opened.

Two instances on the same branch, same shape:

- `settings/types.ts` and `settings/pluginOnlyPolicy.ts` were fixed;
  `settings.ts` — the parent file, and the *authoritative* one — still carried
  `$PROJ_DIR/.claude/settings.json` in the docblock of
  `getSettingsRootPathForSource`. Caught by an auditor, not by me.
- `ScheduleCronTool/prompt.ts` was fixed; `CronCreateTool.ts`, one directory
  over, was not.

**Why:** a grep produces a list of *hits*, and fixing hits feels complete. But
the mental model that forms afterwards is directory-shaped — "I did settings" —
and a second pass over the same area finds nothing because it is looking at the
map instead of the ground. The same dynamic makes a *partially routed file*
survive: hand one line of a file to another owner and keep its neighbour, and the
neighbour is now protected by the file looking handled.

**How to apply:** before declaring a sweep complete, re-run the raw detector over
the whole tree and diff its output against the set of files actually committed.
Any file in the first set and not the second needs an explicit reason, recorded —
"out of partition", "deliberate legacy reader", "different axis" — not silence.
Silence and completeness are indistinguishable at review time, which is why the
second occurrence above got through a reviewer who had already read the first.

**Corollary:** the parent file of a directory you swept is the single likeliest
place for a survivor, because it is not *in* the directory whose name you
remember sweeping.

## Exclusion lists must come from an *unfiltered* search

Same failure at a smaller scale, and the one I actually shipped: I published a
"do not touch" list for `install.tsx` — four theme-colour false positives out of
six hits — built by grepping for the three patterns I already suspected and then
counting the rest **by eye off the excerpt on screen**. The real file has nine
hits and six exclusions. I missed a fifth `color="claude"` and, worse, an
analytics event name (`tengu_claude_install_command`) sitting a hundred lines
outside the window I happened to be reading.

**Why the asymmetry matters:** a filtered search is fine for *finding* defects —
a missed defect is found later, at no cost. It is structurally wrong for
*exclusions*, because the entries you never saw are exactly the ones with no
advocate, and protecting things nobody is currently thinking about is the whole
job of the list. Note also that the missed exclusion was the one that fails
**silently and after the fact**: renaming an analytics event breaks continuity
with historical data instead of showing anyone a wrong string.

**How to apply:** never hand another agent a count you did not produce with a
bare, unfiltered `grep -n <term> <file>`. Paste the raw output. If you find
yourself writing "N hits, M of them fine", that sentence is the trigger to re-run
the search unfiltered before sending.
