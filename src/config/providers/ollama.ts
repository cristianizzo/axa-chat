import { OLLAMA_PROVIDER_ID } from '../ollama.js'
import type { ProviderDescriptor } from './types.js'

export const OLLAMA_PROVIDER = {
  id: OLLAMA_PROVIDER_ID,
  label: 'Ollama',
  description: 'Local or self-hosted models via Ollama',
  apiProvider: 'ollama',
  aliases: [],

  // A local daemon ignores the token, so its presence proves nothing. A
  // completed Ollama login writes both the base URL and the chosen model;
  // require both, so a half-written record is not offered as an account.
  hasCredentials: config => !!config.ollamaAuth?.baseUrl && !!config.ollamaAuth?.model,

  logout: {
    kind: 'configKey',
    message: 'Successfully logged out from your Ollama account.',
    clearCredentials: config => {
      const { ollamaAuth: _removed, ...rest } = config
      return rest
    },
  },

  // The one model it serves is what distinguishes this account.
  accountDetail: config => config.ollamaAuth?.model,

  // Authoritative in the credential record: a login always writes it, and
  // changing it means logging in again. Declaring it here keeps the shared
  // modelByAuthProvider map from being written for Ollama, where it would
  // shadow the real value.
  ownedModel: config => config.ollamaAuth?.model || undefined,

  // No `catalog`: the model is whatever the daemon reported at login.
} as const satisfies ProviderDescriptor
