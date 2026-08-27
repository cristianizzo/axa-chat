import {
  DEEPSEEK_CONTEXT_WINDOW,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODELS,
  DEEPSEEK_PROVIDER_ID,
  DEFAULT_DEEPSEEK_MODEL,
} from '../deepseek.js'
import type { ProviderDescriptor } from './types.js'

export const DEEPSEEK_PROVIDER = {
  id: DEEPSEEK_PROVIDER_ID,
  label: 'DeepSeek',
  // Both pickers render this as `<label> · <description>`, so it must not
  // repeat the label.
  description: 'R1 / V3 via API key (pay-per-token)',
  apiProvider: 'deepseek',
  aliases: [],

  hasCredentials: config => !!config.deepseekAuth?.apiKey,

  logout: {
    kind: 'configKey',
    message: 'Successfully logged out from your DeepSeek account.',
    clearCredentials: config => {
      const { deepseekAuth: _removed, ...rest } = config
      return rest
    },
  },

  apiKeyLogin: {
    prompt: 'Enter your DeepSeek API key:',
    hint: 'Get one at platform.deepseek.com → API keys',
    invalidMessage:
      "That doesn't look like a valid DeepSeek API key. Check the value and try again.",
    storeCredentials: (config, apiKey) => ({ ...config, deepseekAuth: { apiKey } }),
  },

  catalog: {
    models: DEEPSEEK_MODELS,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    acceptsModel: model => DEEPSEEK_MODELS.some(entry => entry.id === model),
    // The same mapping the fetch adapter already applies to any inbound
    // `*haiku*` ID; naming it here makes the adapter's rewrite a no-op rather
    // than the only thing standing between a background job and a 404.
    smallFastModel: DEFAULT_DEEPSEEK_MODEL,
    supportsToolSearch: true,
  },
} as const satisfies ProviderDescriptor
