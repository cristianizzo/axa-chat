import {
  CLAUDE_FAMILY_TO_CODEX_MODEL,
  CODEX_CONTEXT_WINDOW,
  CODEX_MAX_OUTPUT_TOKENS,
  CODEX_MODELS,
  CODEX_PROVIDER_ID,
  DEFAULT_CODEX_MODEL,
  isCodexModelId,
} from '../codex.js'
import type { ProviderDescriptor } from './types.js'

export const CODEX_PROVIDER = {
  id: CODEX_PROVIDER_ID,
  label: 'OpenAI Codex',
  // The only label long enough to push the banner's five-provider line past the
  // panel it has to fit in.
  shortLabel: 'Codex',
  description: 'ChatGPT Plus/Pro subscription',
  apiProvider: 'openai',
  // 'codex' is not implied by the ID: it is `openai-codex`, and matching is
  // exact rather than by substring.
  aliases: ['codex', 'openai'],

  hasCredentials: config => !!config.codexOAuth?.accessToken,

  logout: {
    kind: 'configKey',
    message: 'Successfully logged out from your OpenAI Codex account.',
    clearCredentials: config => {
      const { codexOAuth: _removed, ...rest } = config
      return rest
    },
  },

  // The Codex flow yields only an opaque account ID, so there is nothing worth
  // showing beside the label.

  catalog: {
    models: CODEX_MODELS,
    defaultModel: DEFAULT_CODEX_MODEL,
    contextWindow: CODEX_CONTEXT_WINDOW,
    maxOutputTokens: CODEX_MAX_OUTPUT_TOKENS,
    // Unlisted `gpt-*` IDs are forwarded to the backend untouched, so the
    // membership test has to be the same broad predicate the request path uses
    // rather than a lookup in CODEX_MODELS.
    acceptsModel: isCodexModelId,
    smallFastModel: CLAUDE_FAMILY_TO_CODEX_MODEL.haiku,
    supportsToolSearch: true,
  },
} as const satisfies ProviderDescriptor
