# axa-chat

A large (~500k LOC) TypeScript/Bun fork of Claude Code whose main divergence is
multi-provider support. Upstream Claude Code knowledge is often stale here —
prefer this repo's source over what upstream does.

## Delegate by area

Seven project agents own the codebase between them. Prefer delegating over
exploring inline: each one carries the invariants and traps for its area, which a
cold search will not surface.

| Area | Agent |
|---|---|
| Providers, accounts, auth/OAuth, API transport, retry, models, quota | `axa-provider` |
| Turn loop, messages, sessions, compaction, context assembly, memory | `axa-agent-loop` |
| Tool contract, tool execution, permissions, bash/sandbox | `axa-tools` |
| Ink fork, components, REPL, rendering, keybindings, UI state | `axa-ui` |
| MCP, plugins, skills, hooks, LSP/IDE | `axa-extensibility` |
| Subagents, tasks, teams, worktrees, coordinator, remote | `axa-orchestration` |
| Slash commands, CLI, startup, settings, build/release, telemetry | `axa-platform` |
| Seams between the above, cross-cutting invariants, `docs/ARCHITECTURE.md` | `axa-architect` |

Two habits worth keeping:

- A change spanning areas goes to the **owner of the invariant at risk**, not to
  whoever owns the most changed lines. If no single owner is obvious, or the
  defect *is* the boundary, that's `axa-architect`.
- Independent questions across areas should be delegated **in parallel**, in one
  message.

Don't delegate a single file read, a known path, or a one-line edit — that's
slower than doing it.

## Work as a team by default

Any task with more than one piece of real work in it runs as a team, without being
asked. Follow the `axa-team` skill: `TeamCreate`, one task per unit of work, spawn
the area agents the task might touch as named teammates, then let them **claim their
own tasks** and **message each other directly**. Don't assign owners up front, and
don't relay between them — you as a relay are where a signature or an ordering gets
transcribed wrong and then carries your authority.

Four things stay with you and are never distributed: **the build** (one shared
checkout, one `./cli-dev` — concurrent `build:dev:full` runs clobber each other, so
serialise it), **file-level partitioning** (same single tree: two teammates in one
file overwrite each other), **committing/pushing/merging** (ask the user), and
**contradictions between teammates**, which are a signal to surface rather than
average.

The team is session-scoped — it and its task list are deleted on exit, so don't plan
work that must survive the session. A single lookup or one-file question needs no
team.

## Rules for any work in this repo

- **`.axa/` is the only config dir**, at both user and project scope, and the
  memory file is **`AXA.md`**. A *new* `.claude`/`CLAUDE.md` reader is a defect —
  never add one. The existing ones below are deliberate and must not be "fixed":
  - `LEGACY_CONFIG_DIR_NAME` in `constants/product.ts` — the constant the whole
    migration is built on.
  - `CLAUDE_CODE_DIR` in `services/import/claudeCodeImport.ts` — the source side
    of importing a real Claude Code install.
  - the one-time copy-based import in `utils/legacyProjectImport.ts`.
  - the administrator-deployed system locations reached through
    `getManagedFilePath()` in `utils/config.ts` (`getManagedClaudeRulesDir()`,
    and the managed case of `getMemoryPath`) — deployed by someone who is not us.
  - `'.claude'` in `DANGEROUS_DIRECTORIES` and in the worktree-path check in
    `utils/permissions/filesystem.ts` — removing either takes that protection
    away from exactly the unmigrated projects that still need it.
- **Never add AI attribution** to commits, PRs, or code.
- **Verify a claim against source before asserting it.** This repo has a
  documented history of comments that were checkable and wrong. Line numbers
  drift — treat paths as "look here", not as addresses.
- **Don't ship "known issues, not fixed".** Fix it, or explain why it can't be.
- The dev build is `bun run build:dev:full` → `./cli-dev`. Plain `build:dev`
  silently downgrades the feature set.
- **Never let a test or script write the real global config.** Point the config
  dir env var at a temp location first; a write to the live config hijacks the
  session and forces a re-login.

## Keeping this file honest

`.axa/agents/*.md`, `.axa/skills/*/SKILL.md` and this file describe boundaries
and invariants. When a change invalidates one of those claims, correct it in the
same change — they are loaded before any code is read, so a wrong claim here is
believed by default.
