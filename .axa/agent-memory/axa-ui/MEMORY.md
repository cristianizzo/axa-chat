# Memory Index

> Caveat: `.axa/` is gitignored, so this memory is local to one checkout — not shared via version control, despite what the memory instructions say.

- [Never pre-label an expected-empty result](feedback_never_prelabel_empty_output.md) — an `echo "(empty = clean)"` turns a crashed pipeline into a success message; print counts, not verdicts.
- [Grep can be blind to tracked files](reference_grep_blind_spot_src_cli.md) — unanchored .gitignore hid all of src/cli from rg; use `git grep` for any negative, and check coverage per session.
- [VirtualMessageList key-array precondition](project_message_pipeline_key_invariant.md) — the append fast-path holds only while every collapse stage is an order-preserving single pass; in-place rekey breaks it.
- [heightCache 0 is a sentinel, not a height](project_height_cache_zero_sentinel.md) — 0 means "renders nothing"; never scale it away, never round a real 1 down into it.
- [Writer and verifier must never be the same head](feedback_writer_and_verifier_split.md) — take another agent's diagnosis, never their patch; verify against source and write the code yourself.
- [Typecheck by normalized diff](feedback_typecheck_by_diff.md) — self-generated origin/main baseline in your own worktree, empty diff not a count; the count varies by tree.
