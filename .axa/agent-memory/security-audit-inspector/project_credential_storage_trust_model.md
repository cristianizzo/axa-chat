---
name: Credential storage trust model and the 0600 caveat (axa-chat)
description: Where each provider's credentials live, and why the mode 0o600 on ~/.claude.json is not actually guaranteed for pre-existing config files.
type: project
---

Anthropic credentials go to the OS keychain via `getSecureStorage()`. Every third-party provider (Codex, Ollama, DeepSeek) stores its token/key **in plaintext in `~/.claude.json`** under its own `GlobalConfig` field. That is the accepted design here, not an oversight — but it means a provider key is only as protected as the config file.

**The 0600 caveat:** `saveConfig` passes `mode: 0o600`, but `writeFileSyncAndFlush_DEPRECATED` (`src/utils/file.ts`) only applies that mode when the target does **not** already exist — for an existing file it `statSync`s the target and `chmodSync`s the temp file back to the *existing* mode before the atomic rename. So on any machine where `~/.claude.json` was created 0644, every subsequently stored API key inherits 0644.

**Why:** Found while auditing DeepSeek API key storage (2026-08-22); applies to codexOAuth and ollamaAuth equally.

**How to apply:** Do not accept "written with mode 0600" as mitigation for at-rest plaintext credential findings in this repo. If a finding turns on file permissions, verify the *existing* file's mode, not the write call.
