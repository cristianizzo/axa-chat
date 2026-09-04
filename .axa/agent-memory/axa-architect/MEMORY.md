# Memory Index

- [Typecheck verification traps](reference_typecheck_verification_traps.md) — tsc baseline is 1441; `timeout` fakes a 0-error pass; zsh `"$s:utils/x"` eats the pathspec — brace it, quotes don't help.
- [Audit gate protocol](feedback_audit_gate_protocol.md) — approvals are SHA-scoped; verify the branch, not the implementer's prose; a force-push stays verifiable via orphaned SHAs.
- [Comment standard is higher than "true"](feedback_comment_review_standard.md) — if you must reason your way to acquitting a sentence, it already reads wrong.
- [Two instances break the area partition](feedback_two_instances_break_area_partition.md) — same agent run twice: AXA.md can't resolve ownership; agent-memory has no lock, so Edit never Write.
- [Inline sourcemaps are inert](reference_inline_sourcemaps_are_inert.md) — 548 .tsx carry 12.4 MB of base64; none reach the binary, so "edit desyncs the map" never blocks a fix.
- [ARCHITECTURE.md line-number debt](project_architecture_md_line_numbers.md) — ~112 `file:NNN` citations, accurate but expiring; de-numbering + sandbox section deferred to post-merge.
- [Product-name axis](project_product_name_axis.md) — "Claude Code" in ~193 strings vs PRODUCT_NAME 'AXA Chat'; four categories, not a sed; lead's call, post-merge.
- [`axa install` points at upstream](project_native_updater_points_at_upstream.md) — auto-update path is closed, `axa install` is open: fetches Claude Code from Anthropic's bucket, installs it as `axa`.
- [`isInBundledMode()` ≠ compiled binary](reference_isinbundledmode_is_not_compiled.md) — predicate is `Bun.embeddedFiles.length > 0` = 0 here; its docstring lies and `spawnUtils.ts` already said so.
- [.gitignore hid src/cli from every grep](reference_gitignore_hides_src_cli_from_grep.md) — unanchored `cli` pattern; 19 tracked files invisible to rg; fixed, but check coverage before trusting a negative.
- [Enumerate callers before arguing a path is dead](reference_reachability_and_stale_producers.md) — 3 reviewers each killed one `installLatest` entry point and missed the live one; near-miss gate + self-consistent after-state.
- [MDM/policy anchored to Claude Code](project_upstream_anchors_mdm_policy.md) — same class: ClaudeCode dirs + com.anthropic.claudecode plist govern axa's top-precedence settings; USER_TYPE override is compiled dead.
