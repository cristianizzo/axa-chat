---
name: Two instances of one agent break the area partition
description: When the lead runs axa-architect (or any area agent) twice in one team, AXA.md's per-area ownership no longer resolves who holds a file — ask for a nominal assignment
type: feedback
---

`.axa/AXA.md` partitions the repo by **area**, one owner per row. That resolves
ownership only while each agent runs once. When the lead spawns two instances of the
same agent in one team, both read the identical row in their own definition and both
conclude, correctly and in good faith, that they own the file. The partition has no
coordinate for the case.

**Why:** this happened on `docs/ARCHITECTURE.md` with a second `axa-architect`
running as a co-auditor. Both definitions contain the same line assigning that file.
I re-stated their finding as my own; they were right to reclaim it. Two writers on one
file is the exact structural defect we spend the session flagging in other people's
code, and the rule as written cannot prevent it.

**How to apply:** before touching a cross-cutting file, establish ownership from the
**assignment**, not from the content or from the agent definition. If a peer instance
of your own agent type is on the team, area ownership is not an answer — get a nominal
assignment from the lead and take the loss without arguing if it goes the other way.
A shared *area* is fine and expected; a shared *file* is not.

Related failure of the same shape, worth watching for in myself: clearing a file for
another teammate by inspecting what I could see, rather than checking `git log
origin/main..HEAD -- <file>` on the branches that already had it open. Deduce
ownership from records, never from inspection.

**Why `ARCHITECTURE.md` in particular cannot absorb a second owner.** Grepping all
eight definitions: the file appears in every one. In the seven area agents it is a
*duty to update* the section tracing their area; only `axa-architect` **owns** it.
So it is shared-write by design, eight legitimate writers, and the only thing
holding it coherent is that exactly one agent answers for it. A second copy of that
agent does not add a rival — it removes the single point of coherence.

**The operational hazard this creates, which outlives the ownership question.**
`.axa/agent-memory/<agent>/` is one directory per *agent type*, with **no locking**
— two instances write to it concurrently. `Edit` is safe because it refuses to run
without a prior read, and that guard actually fired here and prevented a clobber.
**`Write` has no such guard**: it would silently overwrite the other instance's
file, with no error.

An earlier version of this paragraph said the store was "versioned in the repo"
and that a clobber "would reach the commit". **Both are false**, and the truth is
worse rather than milder: `.gitignore` line 17 ignores `.axa/` wholesale and
`git ls-files .axa/` returns **zero**. So a `Write` that destroys the other
instance's file produces no diff to review, no orphaned object to recover from,
and no checkout that undoes it. It is simply gone. The operational rule was right;
the reasoning under it understated the urgency. On
any shared memory file, and especially `MEMORY.md`, use `Edit` and never `Write`
unless the file is genuinely new — and check the index first, because both
instances independently created a memory for *this very finding* minutes apart,
which is the divergent-twin defect committed in our own store.
