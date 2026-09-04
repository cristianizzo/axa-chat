---
name: Ollama /v1/messages drops unknown content blocks silently
description: Probed against a live Ollama 0.32.13 daemon — tool_reference blocks and defer_loading are accepted with HTTP 200 and contribute zero tokens; unknown block types never 400.
type: reference
---

Ollama's native Anthropic endpoint (`http://localhost:11434/v1/messages`, the one
the fork points the SDK at) **never rejects a content block it does not
understand**. Verified by probe against a live daemon, version 0.32.13, model
`qwen3:8b`, on 2026-09-04:

- `tool_result` whose content is `[{"type":"tool_reference","tool_name":"..."}]`
  → HTTP 200, `input_tokens` **191**.
- The same request with `content: []` → HTTP 200, `input_tokens` **191**.
- The same request with an equivalent `text` block → HTTP 200, `input_tokens` **199**.

Identical token counts for the tool_reference case and the empty case is the hard
evidence: the block is dropped before prompt construction and contributes exactly
nothing. Behaviourally the model confirms it — asked to name the tool the result
gave it, it answers that the response contained no information, exactly as it does
for an empty content array.

Also probed, all HTTP 200: `defer_loading: true` on a tool schema (ignored), an
`anthropic-beta` header (ignored), and a wholly invented top-level block type —
that last one returns `content: null`, `stop_reason: "stop_sequence"` and
`input_tokens: 0`, i.e. the daemon drops the block, finds nothing left to answer,
and returns an empty message rather than an error.

**Why this matters:** the absence of a 4xx is not evidence of support here. A
capability probe against Ollama must compare token counts or model behaviour
against a control, because every malformed or unsupported shape comes back 200.
Do not conclude "Ollama supports X" from a successful status code.

**How to apply:** when deciding any `supportsX` capability for Ollama, probe with
a control request and compare `usage.input_tokens`. A local daemon is often
running on 11434 — check `curl -s http://localhost:11434/api/version` before
assuming a live probe is impossible.
