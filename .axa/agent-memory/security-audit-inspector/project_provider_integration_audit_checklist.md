---
name: Auth-provider integration audit checklist (axa-chat)
description: Recurring gaps found when a new auth provider (Codex/Ollama/DeepSeek) is bolted on — check logout, switch-account aliases, context window, model picker, and adapter egress.
type: project
---

Every new auth provider in this repo is added the same way (config/<provider>.ts + a fetch adapter + a branch in getAnthropicClient), and each new one has repeated the same integration gaps. Audit this list before signing off on a provider PR:

1. **`/logout` branch** — `src/commands/logout/logout.tsx` `call()` has explicit per-provider branches. A provider with no branch falls through to `performLogout()`, which wipes the **Anthropic** keychain/secureStorage and leaves the new provider's credential on disk. `clear<Provider>Auth()` is typically written but never wired up.
2. **`/switch-account` alias** — `PROVIDER_ALIASES` in `src/commands/switch-account/switchAccount.tsx` must gain an entry, and `describeAccount()` should have an identifying detail.
3. **Context window + max output tokens** — `src/utils/context.ts` special-cases only Codex. A provider whose constants aren't wired there inherits the 200k Claude window and Claude's max_tokens, which the backend then rejects.
4. **Model picker** — `src/utils/model/modelOptions.ts`, `src/utils/model/model.ts` (label + `isModelAllowedForProvider`), `src/utils/modelCost.ts`. Exported `<PROVIDER>_MODELS` arrays are frequently dead code.
5. **Adapter egress bypasses the proxy** — adapters call `globalThis.fetch` directly, so `getProxyFetchOptions()` (proxy/mTLS/NO_PROXY, `ANTHROPIC_UNIX_SOCKET`) is not applied. Under the Bun-compiled binary `undici.setGlobalDispatcher` does not affect Bun's native fetch. Codex and DeepSeek both have this.
6. **Streaming tool-call translation** — the OpenAI→Anthropic tool-call state machine is the highest-risk code in each adapter. Check that `tool_calls[].index` is actually keyed on (not ignored), and that the argument fragment arriving in the same chunk as the tool name is emitted.

**Why:** Verified against Codex (fully wired) vs Ollama vs DeepSeek (2026-08-22 audit) — DeepSeek missed items 1-5.

**How to apply:** When auditing or reviewing a new provider, diff its wiring against `CODEX_*` grep results; anything Codex touches that the new provider does not is a finding.
