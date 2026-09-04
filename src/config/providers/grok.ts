import {
  DEFAULT_GROK_MODEL,
  GROK_CONTEXT_WINDOW,
  GROK_MAX_OUTPUT_TOKENS,
  GROK_MODELS,
  GROK_PROVIDER_ID,
} from '../grok.js'
import type { ProviderDescriptor } from './types.js'

export const GROK_PROVIDER = {
  id: GROK_PROVIDER_ID,
  label: 'Grok',
  // Both pickers render this as `<label> · <description>`, so it must not
  // repeat the label. Company + model code — the DeepSeek ('V4 Flash / Pro …')
  // and Kimi ('Moonshot K3 / K2.7 …') shape — does that without restating
  // 'Grok'.
  description: 'x.ai 4.6 via API key (pay-per-token)',
  apiProvider: 'grok',
  aliases: [],

  hasCredentials: config => !!config.grokAuth?.apiKey,

  logout: {
    kind: 'configKey',
    message: 'Successfully logged out from your Grok account.',
    clearCredentials: config => {
      const { grokAuth: _removed, ...rest } = config
      return rest
    },
  },

  apiKeyLogin: {
    prompt: 'Enter your Grok API key:',
    hint: 'Get one at console.x.ai → API keys',
    invalidMessage:
      "That doesn't look like a valid Grok API key. Check the value and try again.",
    storeCredentials: (config, apiKey) => ({ ...config, grokAuth: { apiKey } }),
  },

  catalog: {
    models: GROK_MODELS,
    defaultModel: DEFAULT_GROK_MODEL,
    contextWindow: GROK_CONTEXT_WINDOW,
    maxOutputTokens: GROK_MAX_OUTPUT_TOKENS,
    // Exact-ID match only: the catalog offers the single current flagship, and
    // x.ai's retired/research variants are deliberately not offered, so there
    // is no legacy list to keep recognising. A stored ID the catalog rejects
    // heals to the default model instead of being served.
    acceptsModel: model => GROK_MODELS.some(entry => entry.id === model),
    // The same mapping the fetch adapter applies to any inbound `claude-*`
    // family ID; naming it here makes the adapter's rewrite a no-op rather than
    // the only thing standing between a background job and a 404.
    smallFastModel: DEFAULT_GROK_MODEL,
    // Grok's endpoint is OpenAI-shaped behind the translating fetch adapter,
    // which renders a `tool_result` as the text of its blocks. ToolSearchTool
    // answers a search that matched with `tool_reference` blocks and one that
    // matched nothing with a plain string, so translation keeps the
    // empty-handed answer and drops the useful one: the model would read "No
    // matching deferred tools found" when the search fails and an empty `tool`
    // message when it succeeds. Not the same reason as Kimi's — Kimi has no
    // adapter, so there the blocks do reach the endpoint.
    supportsToolSearch: false,
    // No maxConcurrentRequests: x.ai does not publish a concurrency allowance
    // tight enough to matter, so the CLI need not space requests out.
  },
} as const satisfies ProviderDescriptor
