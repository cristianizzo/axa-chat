---
name: axa-team
description: Run a task on axa-chat as a self-organising team — create the team and its shared task list, spawn the area agents as teammates, and let them claim their own work and message each other directly. Use for any task in this repo that contains more than one piece of real work.
---

The default way work gets done here. The user gives a task; the team executes it and
decides internally who does what. You are the lead: you set it up, you hold the few
things that must not be distributed, and you report one result. You do not do the
work yourself.

## Why this shape

Subagents cannot talk to each other — they only report back to you. That makes you a
relay, and a relay is where facts get corrupted: a signature, a field name or an
ordering transcribed slightly wrong by you is worse than no answer, because it
arrives with your authority attached.

Teammates have mailboxes and can message each other directly, so the agent who
*changed* the thing tells the agent who *consumes* it, in their own words. That is
the whole reason to pay the coordination cost.

## Setup

1. `TeamCreate({team_name})`. The team and its shared task list are the same object.
   One team per lead — a second `TeamCreate` throws.
2. `TaskCreate` one task per unit of real work. **Do not set owners.** That is the
   point: they choose.
3. Spawn the area agents the task might touch, as teammates — `Agent` with a `name`
   parameter (it is `name` that makes a teammate rather than a plain subagent).

   Spawn the ones that *might* be affected, not only the obvious ones. A teammate
   with nothing to do goes idle immediately and costs little; one you failed to
   spawn is a blind spot nobody notices until the change is already wrong.
4. They claim work themselves: marking a task `in_progress` with no owner auto-assigns
   it to the teammate who did it (`TaskUpdateTool.ts`). Ownership changes are pushed
   into the owner's mailbox automatically.
5. They message each other directly with `SendMessage({to})` — a bare teammate name,
   or `*` to broadcast. Peer-to-peer is allowed; **do not relay for them.**
6. Shut them down, then report a single reconciled result to the user — not eight.

## What stays with you and is never distributed

These exist because no single teammate can see them.

- **The build.** All teammates run in *your* working tree — the spawn path never sets
  a worktree, so there is exactly one checkout and one `./cli-dev`. Concurrent
  `bun run build:dev:full` runs clobber each other. Serialise the build: run it
  yourself, once, after the edits have landed.
- **File-level partitioning.** One tree means two teammates editing the same file
  silently overwrite each other. The seven areas already partition the tree cleanly —
  keep the split along those lines, and if two teammates need the same file, that is
  a boundary problem: give it to `axa-architect`.
- **Committing, pushing, opening a PR, merging.** Ask the user. Never pre-authorised.
- **Contradictions between teammates.** If two report incompatible things, that is a
  signal, not noise. Surface it — do not average it or quietly pick one.

## Constraints worth knowing before you start

- The team is **session-scoped**. On exit, the team directory, its task list and any
  recorded worktrees are deleted. There is no resume — do not plan work that has to
  survive the session.
- Outside tmux or iTerm2 you get **in-process** teammates: they share your process and
  your token budget. For a large task, launching the session inside tmux gives each
  teammate its own process and context.
- Teammates cannot spawn teammates — the roster is flat.
- In-process teammates cannot run background agents.

## When not to use a team

A single lookup, a one-file question, a one-line edit. Standing up a team for that is
pure overhead; answer it directly, or with one plain subagent.
