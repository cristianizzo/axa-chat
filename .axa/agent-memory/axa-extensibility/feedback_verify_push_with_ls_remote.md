---
name: Verify a push landed with git ls-remote, never with the exit code
description: In agent worktrees a detached HEAD makes `git push` succeed while pushing nothing. Confirm the remote ref moved before handing a SHA to anyone.
type: feedback
---

Never report work as pushed on the strength of `git push` exiting 0. Confirm
with `git ls-remote --heads origin <branch>` that the remote ref is the SHA you
meant, and `git status -sb` that HEAD is actually on the branch.

**Why:** in worktree `axa-chat-wt-m6` the checkout was on a **detached HEAD** —
the reflog showed `checkout: moving from fix/... to origin/fix/...`, i.e.
something checked out the *remote-tracking* ref, which detaches. I never did it
and never noticed. From there `git push origin <branch>` is not an error: it
resolves `<branch>` to the **local branch ref**, still at the old commit, and
republishes it unchanged. The push "succeeds", `-q` swallows
"Everything up-to-date", and the new commit stays orphaned. `git rev-parse HEAD`
does not expose it, because HEAD really is the new commit. I told both the
auditor and the lead the work was pushed when the remote had never seen it, and
the review bot kept reviewing the stale head — which reads like a broken bot
rather than a missing push.

**How to apply:** any time work is handed off on the basis of a SHA — audit
requests, review requests, "ready to merge", status reports — verify the remote
ref first. Treat a reviewer that keeps reviewing an old commit as evidence the
push did not land, not as a reviewer bug. Recovery is
`git checkout <branch> && git merge --ff-only <orphan-sha>`; the commit stays
reachable by SHA until gc, so nothing is lost if caught.

This must be a **habit of whoever pushes**, not a periodic sweep. I audited all
16 worktrees once and found none detached — and that snapshot had already
expired by the time the lead read it, because another worktree had moved in the
interim.

**Related, same family:** an approval signature is on a **SHA, not a branch**.
Any push after an approval lapses it and requires a re-audit. Correspondingly,
do not touch a branch while someone is auditing it — that invalidates the
signature under the person writing it.
