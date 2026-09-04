# Free-Code CLI Analysis Results

**Date:** 2026-07-16
**Version analyzed:** 2.1.87 (commit a469885)

---

## 1. Memory Leak Analysis (Critical)

Sessions start at ~400MB and balloon to **15-40GB** over time. Root causes identified:

### Critical Issues

| Issue | File | Lines | Description |
|-------|------|-------|-------------|
| Unbounded message array | `src/QueryEngine.ts` | 186, 431, 768, 785, 830, 916 | `mutableMessages` grows indefinitely — no max size, no eviction. Every tool result, file read, and conversation turn accumulates forever. |
| Permission denials never cleared | `src/QueryEngine.ts` | 188, 263-268 | `permissionDenials[]` array pushed to on every tool denial, never reset between `submitMessage()` calls. |
| Stream reader never released | `src/services/api/codex-fetch-adapter.ts` | 342-347, 578-601 | `reader` from `getReader()` is never released via `releaseLock()` or `cancel()`. No `finally` block for cleanup. |
| loadedNestedMemoryPaths never cleared | `src/QueryEngine.ts` | 198, 371, 519 | Set grows with every nested memory file loaded, never cleared across session lifetime. |

### Why it reaches 40GB

- 1000 turns x 100KB avg message = ~100MB minimum per session
- With file reads, tool outputs, attachments: 500MB-2GB per long session
- Multiple simultaneous sessions compound the issue
- Compact boundary cleanup (lines 926-932) only runs conditionally, not in all code paths
- Local `messages` variable (line 434) holds a copy that grows independently

### Recommended Fixes

```typescript
// Fix 1: Reset permission denials per turn (QueryEngine.ts)
async *submitMessage(...) {
  this.permissionDenials = []  // Reset at start of every turn
}

// Fix 2: Add message size limit (QueryEngine.ts)
private readonly MAX_MESSAGES = 500
// After pushing to mutableMessages:
if (this.mutableMessages.length > this.MAX_MESSAGES) {
  this.mutableMessages = this.mutableMessages.slice(-this.MAX_MESSAGES)
}

// Fix 3: Clear memory paths per session (QueryEngine.ts)
async *submitMessage(...) {
  this.discoveredSkillNames.clear()  // Already done
  this.loadedNestedMemoryPaths.clear()  // ADD THIS
}
```

---

## 2. Resource & Process Management Issues

| Issue | File | Lines | Severity |
|-------|------|-------|----------|
| Voice recorder no SIGKILL fallback | `src/services/voice.ts` | 543-553 | HIGH — zombie processes if SIGTERM ignored |
| SSE close callback silently lost | `src/cli/transports/SSETransport.ts` | 406-415 | HIGH — cleanup chains break |
| No stream backpressure handling | `src/services/api/codex-fetch-adapter.ts` | 296-630 | HIGH — silent data loss possible |
| MCP timeout race condition | `src/services/mcp/client.ts` | 1050-1082 | MEDIUM — Promise.race vs AbortController |
| SSE sequence number Set unbounded | `src/cli/transports/SSETransport.ts` | 360-378 | MEDIUM — grows on long-lived connections |
| MCP auth write chain swallows errors | `src/services/mcp/client.ts` | 291-309 | MEDIUM — cache inconsistency |

---

## 3. Error Handling Gaps

| Issue | File | Lines | Description |
|-------|------|-------|-------------|
| JSON parse errors silently ignored | `src/services/api/codex-fetch-adapter.ts` | 372-376 | Bare `catch { continue }` — events silently dropped |
| Empty request body silently proceeds | `src/services/api/codex-fetch-adapter.ts` | 769-770 | Falls back to `anthropicBody = {}` on error |
| Stack trace lost in extractAccountId | `src/services/api/codex-fetch-adapter.ts` | 74-75 | Catches all errors, throws generic message |
| MCP transport errors swallowed | `src/services/mcp/client.ts` | 1456, 1504 | `.catch{}` without logging |
| Build accepts unknown feature flags | `scripts/build.ts` | 82-110 | No validation against feature enum |

---

## 4. Properly Managed (Not Issues)

These were checked and found to be correctly implemented:

- File watchers (chokidar) — properly closed via `registerCleanup()` + `dispose()`
- Team memory watcher — properly stopped and cleanup registered
- Ink/React event listeners — unsubscribe stored and called
- In-memory error log — bounded at 100 entries with ring buffer
- File state cache — has LRU limits (100 entries, 25MB)

---

## 5. Outdated Model Support

The build only supports up to Opus 4.6 / Sonnet 4.6. Missing models:

| Model | API ID | Released | Pricing (in/out per MTok) |
|-------|--------|----------|--------------------------|
| **Claude Fable 5** | `claude-fable-5` | Jun 9, 2026 | $10 / $50 |
| **Claude Mythos 5** | `claude-mythos-5` | Jun 9, 2026 | Invite-only |
| **Claude Opus 4.8** | `claude-opus-4-8` | 2026 | $5 / $25 |
| **Claude Opus 4.7** | `claude-opus-4-7` | 2026 | $5 / $25 |
| **Claude Sonnet 5** | `claude-sonnet-5` | 2026 | $3 / $15 (intro: $2/$10 until Aug 31) |

### Files requiring updates for new models

All marked with `@[MODEL LAUNCH]` comments:

- `src/utils/model/model.ts` — defaults, display names, canonical names, marketing names
- `src/utils/model/modelStrings.ts` — model ID string constants
- `src/utils/modelCost.ts` — pricing tiers
- `src/utils/model/modelCapabilities.ts` — feature support (adaptive thinking, context window, max output)
- `src/utils/model/modelAllowlist.ts` — allowlist matching patterns

### Key changes needed

1. Add `opus47`, `opus48`, `sonnet5`, `fable5` to model strings
2. Update defaults: Opus 4.8 for Max users, Sonnet 5 for standard
3. Add Fable 5 family (new model family, not opus/sonnet/haiku)
4. Adaptive thinking replaces extended thinking on newer models
5. New tokenizer on Opus 4.7+ (~30% more tokens for same text)
6. 1M context default on Opus 4.8 and Sonnet 5
7. 128k max output on all current models (was 64k on 4.5)

---

## 6. Build & Development Notes

- **Binary**: `cli-dev` is a compiled Bun 1.3.11 arm64 executable (~180MB)
- **Bun version**: 1.3.11 (consider updating — newer versions have memory fixes)
- **Alias**: `claudep` → `~/Developers/free-code/cli-dev`
- **Update command**: `bun run update` (git pull + install + build:dev)
