---
name: axa-ship
description: Take a finished change through the full axa-chat delivery process — branch, commit, PR, then the Copilot review loop until a round comes back clean, then merge. Use when work is complete and ready to ship, or when picking up an open PR that needs another review round.
---

The delivery process for this repo. Follow it end to end; the review loop is the
part people cut short.

## PATH

`gh` and `bun` live in `/opt/homebrew/bin`. If either looks missing, prepend it
rather than concluding the tool is unavailable:

```
export PATH="/opt/homebrew/bin:$PATH"
```

## Open the PR

1. Branch: `feat/...` or `fix/...`.
2. Stage **only relevant source files**. Never `conversation-backup.jsonl`, `.idea/`,
   or built binaries.
3. Commit with a Conventional Commits message (`feat:` / `fix:` / `docs:`).
   **No AI attribution** — no footers, no trailers, no co-author lines.
4. `git push -u origin <branch>`
5. `gh pr create --base main --head <branch> --title "..." --body "$(cat <<'EOF' ... EOF)"`

## Round 1

**Copilot reviews new PRs automatically** — roughly 5–12 minutes after creation, with
no request needed. Just poll. Note that `reviewRequests` reads `[]` while the
automatic review is still pending, so an empty list is *not* evidence nothing is
coming.

```
gh api repos/<owner>/<repo>/pulls/<N>/reviews
```

Read both the review `body` and its inline comments:

```
gh api repos/<owner>/<repo>/pulls/<N>/reviews/<review-id>/comments
```

The body's `<details>` block carries "suppressed comments", which are often the more
substantive findings. Don't skip it.

## Rounds 2+

The automatic review fires **on PR creation only**. Pushing fix-up commits does not
retrigger it. Re-request with the GraphQL mutation — every other method lies:
`gh pr edit --add-reviewer Copilot` fails to resolve, and the REST endpoint silently
drops bot reviewers while returning success.

```
gh api graphql -f query='mutation { requestReviews(input: {
  pullRequestId: "<PR node id>", botIds: ["BOT_kgDOCnlnWA"], union: true
}) { pullRequest { reviewRequests(first:5) {
  nodes { requestedReviewer { ... on Bot { login } } } } } } }'
```

Three things that will waste your time if you get them wrong:

- The field is **`botIds:`, not `userIds:`**. Passing the bot id as a user id fails
  with a message that reads like a stale id. The id is fine.
- **Inline the node id — no GraphQL variables.** `gh api graphql` substitutes `-f`
  pairs textually, so a variable block turns into malformed syntax. The mutation
  above is correct as written.
- `BOT_kgDOCnlnWA` is `copilot-pull-request-reviewer`. Use that literal. A wrong id
  returns success-shaped output with empty `reviewRequests` — which is why the query
  selects them back as proof the request landed.

Get the node id with `gh pr view <N> --json id`. Re-request **after** your final
push; pushing appears to consume a pending request.

## When to stop

Keep looping until a round comes back with **no new real findings** — not a fixed
number of rounds. Judge by content, not index. Real defects have surfaced as late as
round 6; other PRs are clean at round 2 and a third round is pure ceremony.

**Copilot emits false positives** — it has reported an unused parameter that was
used, and a regex error that did not exist. Verify every finding against the code
before acting on it. Pushing back on a wrong finding is correct; silently
"fixing" a non-bug is not.

Then check `mergeStateStatus` and merge. The user has standing-asked to run this
loop through to merge, so completing it is expected rather than something to ask
about each time — but say so if the merge state is anything unusual.

## Do not

- Do not skip hooks (`--no-verify`) or bypass signing to get a commit through.
- Do not ship a "known issues, not fixed" section. Fix them, or explain why not.
- Do not amend a published commit; add a new one.
