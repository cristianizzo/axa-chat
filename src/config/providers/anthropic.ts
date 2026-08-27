import type { ProviderDescriptor } from './types.js'

/** Provider identifier for Anthropic's own API — the default. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic' as const

export const ANTHROPIC_PROVIDER = {
  id: ANTHROPIC_PROVIDER_ID,
  label: 'Anthropic',
  description: 'Claude Pro/Max subscription or Anthropic API key',
  apiProvider: 'firstParty',
  aliases: ['claude'],

  // Anthropic tokens live in the OS keychain, not the config file, and reading
  // them is async and comparatively expensive. `oauthAccount` is written by the
  // same login that stores them, so it stands in for them here.
  hasCredentials: config => !!config.oauthAccount || !!config.primaryApiKey,

  logout: {
    kind: 'anthropicKeychain',
    message: 'Successfully logged out from your Anthropic account.',
  },

  accountDetail: config => config.oauthAccount?.emailAddress,

  // No `catalog`: Anthropic's model list is resolved from the capability
  // registry and the subscription tier, not from a fixed table here.
} as const satisfies ProviderDescriptor
