---
name: Audit gate protocol — verify against the branch, sign an SHA
description: How the team-lead requires pre-PR audits to be conducted in this repo — SHA-scoped approvals, verify source not implementer prose, ask for blast radius
type: feedback
---

An approval is on an **SHA, not a branch**. If the implementer pushes after the
signature, the signature lapses and the round must be redone on the new head.

**Why:** the lead's rule, introduced after I gave an open-ended "open the PR
without coming back to me" and the branch then moved twice underneath it.

**How to apply:**

- Re-read every branch head before asserting anything about it. Heads moved
  under me repeatedly; state the movement explicitly in the report.
- **Check the base too, not just the head.** A signature is on a branch SHA, but
  the branch's *meaning* depends on `main`. When `main` advances mid-session it
  does not auto-lapse the signature — but confirm that what landed does not
  contradict what was approved, and re-check the branch still merges
  (`git merge-tree --write-tree main <branch>`). This caught a real risk once:
  a merge touched `BashTool.tsx`, the referent propping up an approved comment
  claim on another branch. Any typecheck baseline measured against the old
  `main` also stops being proven at that moment.
- **`git diff main..<branch>` is not the branch's change.** It is the difference
  between two points, so on a branch with an older base every commit `main` has
  gained since renders as a *deletion by the branch*. This nearly produced a
  blocking finding from me: two branches appeared to strip `.axa/` and `AXA.md`
  out of `.gitignore`, which would have reopened a closed security hole, and in
  fact they merely predate the commit that added those lines
  (`git merge-base --is-ancestor <commit> <branch>` → NO). Both were also already
  merged — `git merge-base main <branch>` returned the branch head itself. Always
  measure `git diff $(git merge-base main <branch>)..<branch>`, and check
  `git branch --merged main` before attributing intent, because this repo keeps
  merged branches forever by policy so stale heads are the normal case, not the
  exception.
- Verify against the branch, never against the implementer's message. Precedent
  in this team: a correct commit arrived with a false verbal justification.
  The lead's own relayed claims are included in this — "quello che ti scrivo io
  va verificato, non recepito".
- **A signature does not have to wait for a push.** Git worktrees share one
  object store, so an implementer's *unpushed* commit in
  `axa-chat-wt-<branch>` is readable from the main checkout —
  `git cat-file -t <sha>`, `git diff`, `git show "${sha}:path"` all resolve
  (control: a bogus sha gives `fatal: Not a valid object name`). Use this when an
  implementer asks whether to hold a push: audit first, then let them push into a
  signature that already exists, instead of pushing blind and lapsing the old one.
- A force-push does **not** force you to trust the implementer. Orphaned SHAs
  stay in the local object store until gc, so `git diff <old> <new>` still works
  and a history rewrite remains independently verifiable.
- For any security fix, ask explicitly what now happens to cases that previously
  passed. If a legitimate flow breaks, that is blocking and goes to the lead.
- A well-argued, source-proven "this is a false positive" is a legitimate and
  preferred outcome. The findings handed to auditors were never verified.
- Deliver verdicts direct to the implementer by name, without waiting for a
  formal request.
- Typecheck delta-zero means "I did not break the types", not "I did not break
  anything" — see `reference_typecheck_verification_traps.md` for why, and for
  the traps that have already produced wrong verdicts here.
