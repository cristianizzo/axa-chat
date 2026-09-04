---
name: Copilot review loop — the two bot ids and the hidden comments
description: How to actually drive a Copilot re-review to completion on this repo, and where the substantive findings hide. Two traps here each cost a wrong report to the team lead.
type: reference
---

# Driving the Copilot review loop

## Re-review only fires via GraphQL, and only with the right bot id

`gh pr edit N --add-reviewer Copilot` and the REST `requested_reviewers`
endpoint both **fail while looking like they worked**. Use:

```
gh api graphql -f query='mutation { requestReviews(input: {
  pullRequestId: "<PR node id>", botIds: ["BOT_kgDOCnlnWA"], union: true
}) { pullRequest { reviewRequests(first:5) {
  nodes { requestedReviewer { ... on Bot { login } } } } } } }'
```

`botIds:` — not `userIds:`. Inline the node id; `gh api graphql` substitutes
`-f` pairs *textually*, so a variable block produces a syntax error that looks
like broken GraphQL when the mutation is fine.

- `BOT_kgDOCnlnWA` = `copilot-pull-request-reviewer` — **the one that works.**
- `BOT_kgDOC9w8XQ` = `copilot-swe-agent` — **a trap.**

**Why the wrong id deceives:** on #76 the `swe-agent` id *did* trigger the first
review — timeline showed `review_requested` and `copilot-pull-request-reviewer[bot]`
posted. So it reads as correct. Every subsequent re-request with it was accepted
and silently did nothing, with or without `union`. That looks exactly like
"GitHub dedups re-reviews to a bot that already reviewed", which is false, and
led me to tell the lead the loop could not be closed without them clicking the UI
button. Switching to `BOT_kgDOCnlnWA` worked immediately, four rounds running.

**How to apply:** if a re-review will not fire, check the bot id *before*
concluding anything about GitHub or asking a human to intervene. The only proof
the request landed is seeing `copilot-pull-request-reviewer` in the returned
`reviewRequests` — a wrong id returns success-shaped output with an empty list.

## Suppressed comments: the findings that `/comments` does not show

`gh api repos/<o>/<r>/pulls/N/comments` (and
`/pulls/N/reviews/<id>/comments`) **does not return everything**. The review's
`body` carries a `<details>` block of "suppressed comments", and those are
routinely the *more substantive* ones.

On #76 the single best finding of six rounds — a missing `statSync` in the git
worktree fallback in `markdownConfigLoader.ts`, which meant a returned path might
not exist and so falsified a comment I had written — arrived **only** as a
suppressed comment, with no inline comment at all. The team lead was auditing
other PRs with the inline-comments-only method and would have missed it.

**How to apply:** always read the review `body` in full, including the collapsed
`<details>`, not just the inline comment list. A round with zero inline comments
is not necessarily a clean round.

## Closing the loop

Review lands ~5-12 minutes after the request. Poll
`gh api repos/<o>/<r>/pulls/N/reviews`. Match the review to your HEAD by its
**`commit_id`**, never by timestamp — a review posted after your push may still
be describing the previous SHA. Pushing new commits appears to consume a pending
request, so re-request after the final push. Stop when a round finds nothing
real; there is no fixed round cap.
