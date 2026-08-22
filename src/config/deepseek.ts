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
 * `deepseek-reasoner` is the full 671B R1 model — uses chain-of-thought
 * reasoning and exposes it in `reasoning_content` SSE deltas.
 * `deepseek-chat` is the full 671B V3 model — faster, no reasoning overhead.
 *
 * Adding an entry here surfaces it in the `/model` picker for DeepSeek accounts.
 */
export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek R1',
    description: 'Full 671B reasoning model — comparable to Claude Sonnet 5 for coding and math.',
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V3',
    description: 'Full 671B fast model — comparable to Claude 3.5 Sonnet, lower cost.',
  },
] as const satisfies readonly { id: string; label: string; description: string }[]

export type DeepSeekModelId = (typeof DEEPSEEK_MODELS)[number]['id']

/** The model used when an account is first set up or no preference is stored. */
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModelId = 'deepseek-chat'

/**
 * The display label for a listed DeepSeek model.
 *
 * @param model - A model ID
 * @returns The label, or undefined for an unknown model
 */
export function getDeepSeekModelLabel(model: string): string | undefined {
  return DEEPSEEK_MODELS.find(entry => entry.id === model)?.label
}

/**
 * True for any model that will be routed to the DeepSeek backend.
 *
 * @param model - A model ID
 * @returns Whether the model runs on DeepSeek
 */
export function isDeepSeekModelId(model: string): boolean {
  return DEEPSEEK_MODELS.some(entry => entry.id === model)
}

/**
 * Context window for DeepSeek models (input tokens).
 * Both R1 and V3 support 64k input tokens.
 */
export const DEEPSEEK_CONTEXT_WINDOW = 64_000

/**
 * Output token limits for DeepSeek models.
 * Both R1 and V3 support up to 8k output tokens.
 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = {
  default: 8_000,
  upperLimit: 8_000,
} as const
