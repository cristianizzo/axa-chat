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
 * Adding an entry here surfaces it in the `/model` picker for DeepSeek accounts.
 * Retired IDs belong in {@link DEEPSEEK_LEGACY_MODEL_IDS} instead, so they keep
 * working without being offered to new sessions.
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

/**
 * Retired model IDs the API still serves as aliases onto `deepseek-v4-flash`.
 *
 * An account that stored one of these before the V4 rename keeps sending it, so
 * the catalog has to recognise it. It is deliberately kept out of
 * {@link DEEPSEEK_MODELS} so `/model` only ever offers the current IDs.
 *
 * Recognition is not cosmetic: a model no catalog claims falls through to the
 * generic 200k context default, which puts autocompact's threshold at 167k
 * instead of 967k — the same class of bug as the 64k window these IDs used to
 * carry, which compacted DeepSeek sessions at 43k.
 */
export const DEEPSEEK_LEGACY_MODEL_IDS = [
  'deepseek-chat',
  'deepseek-reasoner',
] as const satisfies readonly string[]

/** The model used when an account is first set up or no preference is stored. */
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModelId = 'deepseek-v4-flash'

/**
 * Claude families mapped onto their DeepSeek counterpart.
 *
 * Fable and Mythos take Pro alongside Opus: of the entries in MODEL_REGISTRY
 * they carry the most expensive pricingTier, 'tier_10_50', above every Opus
 * entry in it at 'tier_5_25'.
 */
export const CLAUDE_FAMILY_TO_DEEPSEEK_MODEL = {
  opus: 'deepseek-v4-pro',
  fable: 'deepseek-v4-pro',
  mythos: 'deepseek-v4-pro',
  sonnet: 'deepseek-v4-flash',
  haiku: 'deepseek-v4-flash',
} as const satisfies Record<string, DeepSeekModelId>

/**
 * Resolves a model ID to the DeepSeek model that will actually be served.
 *
 * A `deepseek-*` ID passes through untouched — including the retired
 * `deepseek-chat`/`deepseek-reasoner` aliases, which the API still serves. A
 * Claude family is mapped through {@link CLAUDE_FAMILY_TO_DEEPSEEK_MODEL}, and
 * anything unrecognised falls back to the default rather than being forwarded
 * to a provider that would 404 it.
 *
 * Dependency-free on purpose: the fetch adapter and the account pill both call
 * this, so it must not drag runtime imports into either graph.
 */
export function resolveClaudeModelForDeepSeek(
  claudeModel: string | null | undefined,
): string {
  if (!claudeModel) return DEFAULT_DEEPSEEK_MODEL

  const lower = claudeModel.toLowerCase()
  if (lower.startsWith('deepseek-')) return claudeModel

  const family = (
    Object.keys(CLAUDE_FAMILY_TO_DEEPSEEK_MODEL) as Array<
      keyof typeof CLAUDE_FAMILY_TO_DEEPSEEK_MODEL
    >
  ).find(name => lower.includes(name))

  return family
    ? CLAUDE_FAMILY_TO_DEEPSEEK_MODEL[family]
    : DEFAULT_DEEPSEEK_MODEL
}

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
