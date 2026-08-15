/**
 * Ollama configuration: everything specific to running against a local (or
 * self-hosted) Ollama daemon through its Anthropic-compatible Messages API.
 *
 * Deliberately dependency-free, like config/codex.js — it is imported by the
 * auth-provider registry, the networking layer and `/switch-account`, so it must
 * not drag any runtime dependencies into those import graphs.
 *
 * Ollama v0.14+ exposes a native Anthropic `/v1/messages` endpoint, so requests
 * do not need translating the way Codex does — pointing the Anthropic SDK's
 * baseURL at the daemon is enough. The one endpoint it does NOT implement is
 * `/v1/messages/count_tokens`; the fetch wrapper in ollama-fetch-adapter.ts
 * answers that locally so a token-count probe cannot stall a session.
 */

/** Provider identifier for a local/self-hosted Ollama daemon. */
export const OLLAMA_PROVIDER_ID = 'ollama' as const

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
