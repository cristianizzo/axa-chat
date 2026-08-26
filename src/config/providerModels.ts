import type { AuthProviderId } from './authProviders.js'
import {
  CLAUDE_FAMILY_TO_CODEX_MODEL,
  CODEX_CONTEXT_WINDOW,
  CODEX_MAX_OUTPUT_TOKENS,
  CODEX_MODELS,
  CODEX_PROVIDER_ID,
  DEFAULT_CODEX_MODEL,
} from './codex.js'
import {
  DEEPSEEK_CONTEXT_WINDOW,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER_ID,
  DEFAULT_DEEPSEEK_MODEL,
} from './deepseek.js'
import {
  DEFAULT_KIMI_MODEL,
  KIMI_CONTEXT_WINDOW,
  KIMI_MAX_OUTPUT_TOKENS,
  KIMI_MODELS,
  KIMI_PROVIDER_ID,
  KIMI_SMALL_FAST_MODEL,
} from './kimi.js'

export type ProviderModelOption = {
  id: string
  label: string
  description: string
}

export type ProviderModelCatalog = {
  models: readonly ProviderModelOption[]
  defaultModel: string
  contextWindow: number
  maxOutputTokens: { default: number; upperLimit: number }
  acceptsModel: (model: string) => boolean
  /**
   * What this provider serves in place of Haiku for background work — session
   * titles, away summaries, WebFetch extraction, token estimation.
   *
   * Without it those callers ask for a `claude-*` ID against an endpoint that
   * has never heard of one. Providers with a translating fetch adapter could
   * paper over that on the way out; a provider speaking Anthropic natively has
   * nowhere to do so, which is why the mapping belongs here instead.
   */
  smallFastModel: string
  /**
   * Whether the endpoint accepts `tool_reference` blocks.
   *
   * The existing gate in toolSearch.ts only recognises an Anthropic-shaped
   * proxy sitting behind `firstParty`, so a provider with its own APIProvider
   * ID falls straight through it and is assumed capable.
   */
  supportsToolSearch: boolean
}

/**
 * Model capabilities for providers whose complete model catalog is known locally.
 *
 * Anthropic's catalog is resolved from its capability registry and subscription
 * state, while Ollama's one model is discovered at login. Those providers do not
 * belong here. New fixed-catalog providers add one entry and every model-facing
 * consumer can use the same source of truth.
 */
export const PROVIDER_MODEL_CATALOGS: Partial<
  Record<AuthProviderId, ProviderModelCatalog>
> = {
  [CODEX_PROVIDER_ID]: {
    models: CODEX_MODELS,
    defaultModel: DEFAULT_CODEX_MODEL,
    contextWindow: CODEX_CONTEXT_WINDOW,
    maxOutputTokens: CODEX_MAX_OUTPUT_TOKENS,
    // Codex allows unlisted gpt-* IDs as passthrough and codex-* IDs; match
    // case-insensitively to mirror the original isCodexModelId check.
    acceptsModel: (model: string) => {
      const m = model.toLowerCase()
      return m.startsWith('gpt-') || m.includes('codex')
    },
    smallFastModel: CLAUDE_FAMILY_TO_CODEX_MODEL.haiku,
    supportsToolSearch: true,
  },
  [DEEPSEEK_PROVIDER_ID]: {
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    acceptsModel: model => DEEPSEEK_MODELS.some(entry => entry.id === model),
    // The same mapping the fetch adapter already applies to any inbound
    // `*haiku*` ID; naming it here makes the adapter's rewrite a no-op rather
    // than the only thing standing between a background job and a 404.
    smallFastModel: 'deepseek-chat',
    supportsToolSearch: true,
  },
  [KIMI_PROVIDER_ID]: {
    models: KIMI_MODELS,
    defaultModel: DEFAULT_KIMI_MODEL,
    contextWindow: KIMI_CONTEXT_WINDOW,
    maxOutputTokens: KIMI_MAX_OUTPUT_TOKENS,
    acceptsModel: model => KIMI_MODELS.some(entry => entry.id === model),
    smallFastModel: KIMI_SMALL_FAST_MODEL,
    // Moonshot's shim implements the Messages API, not the beta surface around
    // it. `tool_reference` blocks are part of that surface, and the gate in
    // toolSearch.ts only knows how to recognise a proxy hiding behind
    // `firstParty` — so without this the request goes out with blocks the
    // endpoint has no handler for.
    supportsToolSearch: false,
  },
}

export function getProviderModelCatalog(
  provider: AuthProviderId,
): ProviderModelCatalog | undefined {
  return PROVIDER_MODEL_CATALOGS[provider]
}

export function getProviderModelCatalogForModel(
  model: string,
): ProviderModelCatalog | undefined {
  return Object.values(PROVIDER_MODEL_CATALOGS).find(catalog =>
    catalog?.acceptsModel(model),
  )
}
