# Memory Index

- [GrowthBook & feature flags are structurally dead](growthbook_dead_external.md) — external build: GB disabled (1P logger stub), GB overrides ant-only; feature('X') true only if declared in build.ts list.
- [Never escape ${} in nested prompt templates](feedback_nested_prompt_template_escaping.md) — `\${X}` ships a constant's name to the model; nothing catches it, so execute the builder to verify.
- [Claims have several axes — verify all of them](feedback_verify_command_strings_against_registration.md) — right binary + fake subcommand; right path + wrong scope. Fixing one axis launders the rest.
- [Brace form vs literal in comments](feedback_constant_reference_vs_transcript.md) — `{MEMORY_FILE_NAME}` for constant-references, literal `axa …` for commands the user copy-pastes. The mix is intentional.
- [`axa install` ships upstream Claude Code](project_axa_install_ships_upstream.md) — ungated subcommand downloads from Anthropic's GCS bucket and installs it as `axa`; destination was forked, source wasn't. Open.
- [A clean negative may be a command that never looked](feedback_clean_negatives_from_blind_commands.md) — rg obeys .gitignore, zsh aborts on unquoted globs, aliased imports hide callers. Verify the search looked.
- [Sweep the files, not the directory](feedback_sweep_the_files_not_the_directory.md) — twice: subdir fixed, parent/sibling file survived because the area looked handled. Diff detector output vs committed files.
