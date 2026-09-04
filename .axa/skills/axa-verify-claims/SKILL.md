---
name: axa-verify-claims
description: Check every factual claim in a comment, docstring, or doc against the actual source, and correct the ones that are wrong. Use after writing documentation or comments, when reviewing a PR that adds them, or when auditing an existing file for comment rot.
---

Comments in this repo have a track record of being confidently wrong. This skill is
the antidote: treat every claim as a hypothesis and go check it.

## Method

For each comment, docstring, or documentation sentence in scope:

1. **Extract the claims.** A claim is anything checkable: "X is called from Y",
   "this runs before Z", "only A does B", "defaults to N", "this is the single
   place that...". Prose that merely restates the code is not a claim — skip it.
2. **Check each one against source.** Grep for the symbol. Read the caller. Confirm
   the ordering. Do not reason from the surrounding comment, from upstream Claude
   Code behaviour, or from what the code *looks* like it should do.
3. **Classify:** correct / wrong / unverifiable-as-stated / stale (was true, no
   longer is).
4. **Fix the wrong ones.** Prefer correcting the claim over deleting the comment —
   the comment usually exists because the code was non-obvious.
5. **Delete claims that cannot be checked**, rather than softening them into vague
   statements that are technically unfalsifiable.

## Claims that deserve extra suspicion

- Exclusivity: "the only", "never", "always", "nothing else".
- Call-graph assertions: "called from", "not on the path", "unused".
- Ordering and timing: "runs before", "after the trust gate", "once per turn".
- Counts: "seven checks", "three branches" — these rot the moment someone adds one.
- Line-number references. Prefer "look here" pointers over addresses.

## Agent definitions and skills are in scope

`.axa/agents/*.md` and `.axa/skills/*/SKILL.md` are dense with exactly the kind of
claim listed above — ownership boundaries, orderings, invariants, "the only place
that...". They are loaded into a subagent's context *before* it reads any code, so a
wrong claim there is believed by default and propagates into every session.

So: after a source change that touches a described boundary, re-verify the agent
definition and the skills that describe it, and correct them in the same change.
Two failure modes to look for specifically:

- A file or directory listed under "You own" that has been moved, renamed, or split.
- An invariant or ordering that a refactor has made false, or has made unnecessary.

## Reporting

State what you checked and how. For each correction, give the claim, the evidence
that disproves it, and the replacement. Do not produce a "possible issues" list —
either you verified it or you did not.

Do not add AI attribution to any commit or PR produced from this work.
