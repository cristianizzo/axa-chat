---
name: Writer and verifier must never be the same head
description: When another agent already has a fix formulated, take their diagnosis but write the code yourself — accepting their patch destroys the audit on that line.
type: feedback
---

If an auditor or another teammate offers a ready-made patch, take the **diagnosis** and write the code yourself, then state in one line which part of the reasoning was theirs and which you verified.

**Why:** the lead's words — if the auditor writes the code and then signs it, the audit on that line no longer exists. Separation of writer and verifier was the only thing that held across a large multi-agent fix session.

**How to apply:** whenever you're blocked and someone says "I already have the fix". Ask for reasoning only. Re-verify every claim against source before writing a line — including whether the diagnosis is even about the right construct, since a plausible reading of a finding can be a correct analysis of the wrong thing (e.g. reading "sentinel" as a boolean latch when it meant a cached value of `0`).
