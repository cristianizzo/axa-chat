/**
 * Grok configuration: everything specific to running against x.ai's Grok API.
 *
 * Deliberately dependency-free, like config/deepseek.ts and config/codex.ts —
 * it is imported by the auth-provider registry, the networking layer and
 * `/switch-account`, so it must not drag runtime dependencies into those graphs.
 *
 * Grok exposes an OpenAI-compatible Chat Completions endpoint, so requests need
 * translating from the Anthropic Messages format the SDK emits. The fetch
 * adapter in grok-fetch-adapter.ts handles that translation.
 */

/** Provider identifier used in config storage to distinguish Grok credentials. */
export const GROK_PROVIDER_ID = 'grok' as const

/** The base URL for Grok's OpenAI-compatible API. */
export const GROK_BASE_URL = 'https://api.x.ai'

/** The chat completions endpoint path. */
export const GROK_MESSAGES_PATH = '/v1/chat/completions'

/**
 * Models available through Grok's API.
 *
 * x.ai also serves grok-4.5, grok-4.3, grok-build-0.1 and the grok-4.20-*
 * reasoning/multi-agent variants, but this fork deliberately offers only the
 * current flagship for now. Adding an entry here surfaces it in the `/model`
 * picker for Grok accounts.
 */
export const GROK_MODELS = [
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    description: "x.ai's flagship model with a 500k context window — the default workhorse.",
  },
] as const satisfies readonly { id: string; label: string; description: string }[]

export type GrokModelId = (typeof GROK_MODELS)[number]['id']

/** The model used when an account is first set up or no preference is stored. */
export const DEFAULT_GROK_MODEL: GrokModelId = 'grok-4.6'

/**
 * Context window for Grok models (input tokens).
 * Verified live against GET /v1/models — grok-4.6 advertises 500k.
 */
export const GROK_CONTEXT_WINDOW = 500_000

/**
 * Output token limits for Grok models.
 * The cap grok-4.6 actually accepts is not yet pinned down, so the upper limit
 * is a conservative 200k; the default stays in line with the Claude models so a
 * normal turn doesn't reserve an absurd slot.
 */
export const GROK_MAX_OUTPUT_TOKENS = {
  default: 32_000,
  upperLimit: 200_000,
} as const
