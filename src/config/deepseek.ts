/**
 * DeepSeek configuration: everything specific to running against DeepSeek's API.
 *
 * Deliberately dependency-free, like config/codex.ts and config/ollama.ts —
 * it is imported by the auth-provider registry, the networking layer and
 * `/switch-account`, so it must not drag runtime dependencies into those graphs.
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions endpoint, so requests
 * need translating from the Anthropic Messages format the SDK emits. The
 * fetch adapter in deepseek-fetch-adapter.ts handles that translation.
 */

/** Provider identifier used in config storage to distinguish DeepSeek credentials. */
export const DEEPSEEK_PROVIDER_ID = 'deepseek' as const

/** The base URL for DeepSeek's OpenAI-compatible API. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** The chat completions endpoint path. */
export const DEEPSEEK_MESSAGES_PATH = '/v1/chat/completions'

/**
 * Models available through DeepSeek's API.
 *
 * Both V4 models support thinking and non-thinking modes; thinking is exposed
 * in `reasoning_content` SSE deltas. Flash is the workhorse, Pro trades a much
 * lower concurrency limit and a higher price for more capability.
 *
 * The retired `deepseek-chat` / `deepseek-reasoner` IDs are still accepted by
 * the API as aliases (both resolve to `deepseek-v4-flash`), so an account with
 * one of them persisted keeps working — it just no longer appears in `/model`.
 *
 * Adding an entry here surfaces it in the `/model` picker for DeepSeek accounts.
 */
export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Fast 1M-context model with optional thinking — the default workhorse.',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Most capable V4 model — higher price and much lower concurrency.',
  },
] as const satisfies readonly { id: string; label: string; description: string }[]

export type DeepSeekModelId = (typeof DEEPSEEK_MODELS)[number]['id']

/** The model used when an account is first set up or no preference is stored. */
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModelId = 'deepseek-v4-flash'

/**
 * Context window for DeepSeek models (input tokens).
 * Every V4 model advertises 1M.
 */
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000

/**
 * Output token limits for DeepSeek models.
 * V4 accepts up to 384k output tokens; the default stays in line with the
 * Claude models so a normal turn doesn't reserve an absurd slot.
 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = {
  default: 32_000,
  upperLimit: 384_000,
} as const
