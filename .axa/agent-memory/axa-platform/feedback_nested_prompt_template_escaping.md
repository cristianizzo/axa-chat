---
name: Nested prompt template literals — never escape the dollar sign
description: In src/tools/*/prompt.ts the body escapes backticks; escaping ${...} too silently ships a constant's name to the model. Verify by executing the builder, not by reading the diff.
type: feedback
---

Prompt builders under `src/tools/*/prompt.ts` return a template literal whose
body contains markdown code spans, so backticks are escaped as `` \` ``. Do
**not** carry that escaping over to interpolations: `\${CONFIG_DIR_NAME}` is not
an interpolation, and the model receives the literal text `${CONFIG_DIR_NAME}`
instead of a path.

**Why:** this shipped and failed an audit. Substituting a constant's *name* for
a path is worse than the wrong path it replaced — a wrong-but-plausible
directory is at least actionable; a TypeScript identifier is not. Nothing in
this repo catches it: it typechecks, it parses, and the resulting unused import
raises nothing because `noUnusedLocals` is off and there is no lint script.

**How to apply:** when changing any string that reaches the model or the user —
prompt bodies, zod `.describe()`, tool result strings — **execute the builder
and assert on its output**. Reading the diff is not verification for a template
literal. A cheap static screen is `grep '\\\${'` across changed files, but
validate the detector against the broken state (e.g. via `git stash`) before
trusting a clean result; a detector never seen to fail is not evidence.

**The mirror-image trap:** `${CONFIG_DIR_NAME}` written in a `//` or JSDoc
comment does not interpolate either — it just ships a dead constant name to the
next reader. In comments write the literal (`.axa`, `AXA.md`); interpolate only
inside real template literals.

**The real invariant, and why the line-based screen is not enough.** `${` is
only meaningful inside a backtick literal, so *both* directions are the same
defect: an interpolation whose enclosing literal is not what the author assumed.
A `${X}` in a `'…'` or `"…"` string is as broken as one in JSDoc. But a
line-local regex **cannot** decide this and produces mostly false positives:
`` `Removed server "${name}"` `` matches on the quoted substring, and every line
of a multi-line template body has no backtick on it at all, so an apostrophe
(`- If there's already a ${MEMORY_FILE_NAME}`) matches too. Enclosure is lexical
state; recover it with a small lexer that tracks quote/template/comment state
with a stack for nested `${ }` and handles escapes. Validate any such detector
against a fixture containing all four defect classes **and** the look-alike good
cases (nested ternary templates, quoted substrings, apostrophes, escaped
backticks) before trusting a clean run.

**Legitimate `${...}` that must not be "fixed":** `${CLAUDE_PLUGIN_DATA}` and
`${CLAUDE_PLUGIN_ROOT}` are plugin-facing placeholder tokens substituted
literally by `.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, …)`. The braces are part of
the token's real spelling, so writing them that way in a comment is correct.

Related trap: a verifier that names a field wrong (`planDirectory` for
`plansDirectory`) returns `undefined` and looks like a pass. Assert that the
description exists, not merely that it lacks a bad substring.
