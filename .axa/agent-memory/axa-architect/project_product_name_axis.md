---
name: Product-name axis — "Claude Code" in strings while PRODUCT_NAME is 'AXA Chat'
description: A ~193-string, 185-file cross-area sweep that is NOT a sed — three distinct categories plus dead Anthropic-internal Slack routing; deferred to the lead post-merge
type: project
---

`PRODUCT_NAME` is `'AXA Chat'` (`src/constants/product.ts`) and `BINARY_NAME` is
`'axa'`, but the *prose* in user- and model-facing strings still says "Claude Code".
This is a **different axis** from the binary/path one that M20 fixed
(`claude update` → `${BINARY_NAME} update`, `~/.claude/local` → `getLocalInstallDir()`).

Measured, not estimated: `git grep "Claude Code" -- src/` → **388 hits / 185 files**;
**193** once restricted to quoted/backtick literals with comment lines excluded.
Nobody has classified all 193 — do not quote a smaller number as though someone has.

**Why it matters and why it is not a `sed`.** The 193 are at least four things:

1. **Self-reference — real drift.** `services/tips/tipRegistry.ts`
   ("/mobile to use Claude Code from the Claude app on your phone"),
   `skills/bundled/stuck.ts`, `skills/bundled/debug.ts`. These describe *this* program.
2. **Model-facing identity — a product decision, not a rename.**
   `constants/system.ts` `DEFAULT_PREFIX` and its Agent-SDK sibling,
   `constants/prompts.ts` (~:470), `DEFAULT_AGENT_PROMPT`. Changing these changes what
   the model is told it is; it may be deliberate and load-bearing.
3. **References to the genuine other product — must stay.**
   `constants/github-app.ts` writes an actual Claude Code GitHub workflow into the
   user's repo. Same reason M10's commit body "drafted by a Claude Code on the web
   session" is not an attribution violation.
4. **Dead Anthropic-internal routing — worse than a stale name.**
   `constants/prompts.ts` (~:263) tells the model to route bug reports to
   `#claude-code-feedback` (`C07VBSHV7EV`) via `/issue` and `/share`;
   `skills/bundled/stuck.ts` posts there too. In a fork the model confidently offers
   a user a channel he cannot reach.

The exemplar that exposes it is `src/bridge/bridgeEnabled.ts` (~:170), which *after*
M20 reads "Your version of Claude Code (…) is too old" while saying `axa update` —
one sentence, internally inconsistent. Fixing one axis is what makes the other
visible; that is not a defect in M20.

**How to apply:** it spans all seven areas (`commands` 24, `constants` 8,
`components/permissions` 8, `utils/settings` 7, `tools/AgentTool` 7, `components/mcp` 7,
`skills/bundled` 6, …), so it has **no single area owner** and is a partitioning
decision for the lead — delivered to them 2026-09-04, deferred until the nine fix
branches merge, on the same reasoning as the ARCHITECTURE.md de-numbering: 185 files
landing mid-flight conflicts with every open branch. Category 2 needs a *policy*
before anyone touches a line. Do not pick it up without a nominal assignment.
