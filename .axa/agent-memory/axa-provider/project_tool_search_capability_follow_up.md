---
name: supportsToolSearch belongs on ProviderDescriptor, as a required field
description: Agreed follow-up to PR #79 — lift supportsToolSearch out of ProviderModelCatalog so catalog-less providers can state it; required, and explicitly not collapsed into an "is Anthropic" predicate.
type: project
---

`supportsToolSearch` currently lives inside `ProviderModelCatalog`, and the gate in
`toolSearch.ts` reads `if (catalog && !catalog.supportsToolSearch)`. The agreed fix
is to lift the field onto `ProviderDescriptor` as a **required** member, Anthropic
`true` and every other provider `false`, changing the single call site.

**Why:** `catalog` is optional and absent for exactly two providers — Anthropic
(catalog comes from the capability registry and subscription state) and Ollama (the
model is whatever the daemon reported at login) — and those two want *opposite*
answers. So the `catalog &&` is load-bearing for Anthropic and cannot be inverted,
while Ollama passes the gate as capable purely by omission, with no container in
which to say otherwise. Optional-on-the-descriptor would relocate the bug rather
than close it; required plus the exhaustive `PROVIDERS` record turns the next
provider's silence into a compile error instead of an assumed yes.

Two decisions taken explicitly, so they are not re-litigated:

- **Do not give Ollama a catalog.** It would demand `models`, `defaultModel`,
  `contextWindow`, `maxOutputTokens`, `acceptsModel` and `smallFastModel` — values
  that for Ollama are either nonexistent or lies.
- **Do not collapse the field into an "is Anthropic" predicate**, even though after
  PR #79 every non-Anthropic provider is `false`. The reason is per-endpoint, not
  per-vendor; a future provider can flip it, and a predicate would delete the place
  where each provider's reason is written down.

**How to apply:** this is a separate branch (`fix/tool-search-capability-on-descriptor`),
deliberately sequenced *after* PR #79 merges so the diffs do not cross on the same
lines. The Ollama token-delta probe is the central evidence for that PR — see the
Ollama endpoint memory for why a status code proves nothing there.
