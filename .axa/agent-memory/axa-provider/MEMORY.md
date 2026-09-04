# Memory Index

- [Ollama /v1/messages drops unknown blocks silently](reference_ollama_anthropic_endpoint_behaviour.md) — every unsupported shape returns 200; probe capabilities by token delta, never by status code.
- [supportsToolSearch belongs on ProviderDescriptor](project_tool_search_capability_follow_up.md) — agreed follow-up to PR #79: required field, no catalog for Ollama, no "is Anthropic" predicate.
- [rg is blind to docs/ and .axa/](reference_grep_blind_spots.md) — unanchored gitignore patterns; verify every negative with `rg --no-ignore`, the git ls-files check misses this.
