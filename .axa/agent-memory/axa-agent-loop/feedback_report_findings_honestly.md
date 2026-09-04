---
name: A false positive is a valid outcome — say so, don't reshape the report
description: When a reported finding is false as written, state that plainly rather than rewriting it to fit; and retract your own overstatements before they reach a PR.
type: feedback
---

When a finding handed to you is false as formulated, **say so in plain words in the
PR or report**, with the citation that proves it — do not quietly rewrite the
formulation so that it appears correct. If a real defect sits underneath, present it
as a second, distinct thing rather than folding it into the original wording.

**Why:** the lead's stated position is that reshaping a false report to fit destroys
the ability to tell a verified claim from an accommodated one. Separately, when I
told the lead a piece of global state "stays dirty for the session", the lead
escalated it to "permanent damage" — checking the actual reset call sites showed the
state *is* cleared, just not by the command that dirtied it. The lead's verdict on
the retraction: the corrected version was *stronger*, not weaker.

**How to apply:**
- Verify a lead's framing against source before adopting it. Dismantling a lead's
  concern with evidence is the expected behaviour, not insubordination.
- Retract your own overstatements the moment you find them, before they reach a PR
  body where they'd carry your authority.
- Lead a report with its most serious item. A real defect described as a footnote to
  a false positive gets archived unread.
- Never ship a "known issues, not fixed" section — fix it, or explain why it can't be.
- Dead code created *by your own fix* must go in the same change: left in place it
  reads as evidence that the invariant you just established does not hold. Prefer
  making it impossible (a narrowing predicate, a non-optional type) over deleting it.
