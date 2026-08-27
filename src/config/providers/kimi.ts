import {
  DEFAULT_KIMI_MODEL,
  KIMI_CONTEXT_WINDOW,
  KIMI_MAX_CONCURRENT_REQUESTS,
  KIMI_MAX_OUTPUT_TOKENS,
  KIMI_MODELS,
  KIMI_PROVIDER_ID,
  KIMI_SMALL_FAST_MODEL,
} from '../kimi.js'
import type { ProviderDescriptor } from './types.js'

export const KIMI_PROVIDER = {
  id: KIMI_PROVIDER_ID,
  label: 'Kimi',
  description: 'Moonshot Kimi K3 / K2.7 via API key (pay-per-token)',
  apiProvider: 'kimi',
  aliases: ['moonshot'],

  hasCredentials: config => !!config.kimiAuth?.apiKey,

  logout: {
    kind: 'configKey',
    message: 'Successfully logged out from your Kimi account.',
    clearCredentials: config => {
      const { kimiAuth: _removed, ...rest } = config
      return rest
    },
  },

  catalog: {
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
    maxConcurrentRequests: KIMI_MAX_CONCURRENT_REQUESTS,
  },
} as const satisfies ProviderDescriptor
