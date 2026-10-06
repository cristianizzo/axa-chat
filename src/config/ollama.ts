/**
 * Ollama configuration: everything specific to running against a local (or
 * self-hosted) Ollama daemon through its native chat API.
 *
 * Deliberately dependency-free, like config/codex.js — it is imported by the
 * auth-provider registry, the networking layer and `/switch-account`, so it must
 * not drag any runtime dependencies into those import graphs.
 *
 * Ollama v0.14+ also exposes an Anthropic-compatible `/v1/messages` shim, which
 * this fork used to point the SDK's baseURL at directly. That shim does not
 * expose or use the daemon's prompt/KV cache — verified empirically against a
 * running daemon: identical shared-prefix requests always reported
 * `cache_read_input_tokens: 0` through `/v1/messages`, while the native
 * `/api/chat` endpoint reused 97-99.8% of an identical prompt from cache on the
 * same model. Every turn therefore re-evaluated the entire system prompt and
 * tool catalog from scratch, which is most of why a local chat turn could take
 * tens of seconds. ollama-fetch-adapter.ts now translates through `/api/chat`
 * instead, the same way Grok and DeepSeek translate through their own native
 * endpoints, so it needs no `/v1/messages/count_tokens` either — the adapter
 * answers that locally, like the other translating adapters do.
 */

/** Provider identifier for a local/self-hosted Ollama daemon. */
export const OLLAMA_PROVIDER_ID = 'ollama' as const

/** The native chat endpoint path, relative to the daemon's base URL. */
export const OLLAMA_CHAT_PATH = '/api/chat'

/**
 * Where the Ollama daemon listens by default. Ollama binds this port out of the
 * box, and `ollama signin` lets it proxy `*:cloud` models through the same
 * address — so a single local URL covers both local and cloud models.
 */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/**
 * The Ollama base URL to talk to.
 *
 * @returns `OLLAMA_BASE_URL` if set, otherwise the default local daemon address
 */
export function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL
}

/**
 * The bearer token to present to Ollama.
 *
 * A local daemon ignores it, so any non-empty placeholder works; Ollama Cloud
 * expects a real key. Sent as `Authorization: Bearer`, which is what Ollama
 * Cloud's Anthropic endpoint requires (it rejects `x-api-key`).
 *
 * @returns `OLLAMA_API_KEY` if set, otherwise the ignored-locally placeholder
 */
export function getOllamaAuthToken(): string {
  return process.env.OLLAMA_API_KEY?.trim() || 'ollama'
}
