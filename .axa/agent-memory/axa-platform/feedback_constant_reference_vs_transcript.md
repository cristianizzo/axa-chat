---
name: Brace form is for constant-references; literals are for transcripts
description: When a comment names a value, use {MEMORY_FILE_NAME}; when it quotes a command the user types, use the literal `axa …`. The cut is what the reader does with the text, not comment-vs-string.
type: feedback
---

Two forms appear in comments in this repo and they are **not** interchangeable:

- `{MEMORY_FILE_NAME}`, `{CONFIG_DIR_NAME}` — used in `claudemd.ts` and
  `import-project.tsx`. Correct when the comment names **a constant whose
  spelling is configuration**. The reader needs "whatever `MEMORY_FILE_NAME` is";
  writing `AXA.md` there creates a second source of truth that drifts silently.
- A literal `axa plugin marketplace update` — correct when the comment quotes **a
  command line a user types**. `{BINARY_NAME} plugin marketplace update` is not
  copy-pasteable, and would be the only place in the tree where a comment renders
  an invocation nobody can run.

**Why:** the rule I was carrying — "comments use the brace form, strings
interpolate" — classifies by *syntactic position*, and gives the wrong answer for
a transcript inside a comment. The real question is **what the reader is meant to
do with the text**: a constant-reference is *read*, a transcript is *executed*.
Position is a proxy that fails exactly where the two forms meet.

Note the brace form deliberately omits the `$`: `{MEMORY_FILE_NAME}`, never
`${MEMORY_FILE_NAME}`. A `${…}` inside a comment or a `'…'`/`"…"` string is the
separate documented defect — an interpolation that never runs.

**How to apply:** before converting a hardcoded value in a comment, ask whether a
reader would copy it into a shell. If yes, keep the literal and let it be
maintained as a transcript. If no, use the brace form. Do not "consistency-fix"
one into the other across a file — the mix is intentional.
