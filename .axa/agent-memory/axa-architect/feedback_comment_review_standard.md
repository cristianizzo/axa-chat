---
name: The comment standard is higher than "true"
description: A comment can be literally true and still a defect if a reader with full context must reason his way to acquitting it — the tell, and why it outranks the no-false-claims rule
type: feedback
---

The repo rule is "no checkable-and-wrong comments". That is the floor, not the bar.
A second class exists: **true, but positioned so the fast read lands wrong.**

**The tell:** if an auditor holding full context has to *reason his way to acquitting*
a sentence — "read narrowly it governs only X, so it is true" — the sentence has
already cost more than it saves. A reader without that context does not do the
reasoning; he takes the wrong meaning and moves on.

**Why:** established while auditing `fix/skill-watcher-axa-path`. I signed off on a
comment as true; the implementer then deliberately let my signature lapse to rewrite
it anyway, quoting my own "read narrowly … so it is true" back at me as the proof it
needed rewriting. He was right. The fix is almost always to say what the sentence is
silent about — e.g. a stat-existence claim that is true of the walked levels but says
nothing about the fallback path, which the reader assumes it covers.

**How to apply:** when reviewing a comment, do not stop at "is this true?". Ask what
a reader arriving cold will take it to mean, and whether the sentence is silent about
an adjacent case it appears to cover. Raise it as a note rather than a blocker — it
is a quality point, not a correctness one — but do raise it. Do not accept
"technically accurate" as the end of the discussion, including from myself.
