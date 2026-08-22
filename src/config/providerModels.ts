import type { AuthProviderId } from './authProviders.js'
import {
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
  },
  [DEEPSEEK_PROVIDER_ID]: {
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    acceptsModel: model => DEEPSEEK_MODELS.some(entry => entry.id === model),
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
