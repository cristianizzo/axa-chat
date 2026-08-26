/**
 * The registry of accounts a user can log in with, and how each maps onto the
 * API provider used to serve requests.
 *
 * Exists because "which provider am I talking to" used to be answered purely by
 * environment variables (CLAUDE_CODE_USE_BEDROCK and friends). That works for
 * cloud deployments, where an operator sets the env once, but not for
 * subscription logins: a user who runs `/login` and picks their ChatGPT account
 * should get the OpenAI backend without also having to export a flag. So the
 * login records which provider it authenticated, and this table translates that
 * into an {@link APIProvider}.
 *
 * Adding a provider means adding an entry here plus the credential check in
 * hasCredentialsForAuthProvider (utils/activeAuthProvider.ts) — everything that
 * enumerates accounts (the `/login` picker, `/switch-account`) reads this list.
 *
 * Dependency-free apart from the sibling config/*.js provider modules, which are
 * themselves dependency-free. The `/login` UI, the networking layer and the
 * model picker all import this.
 */

import { CODEX_PROVIDER_ID } from './codex.js'
import { DEEPSEEK_PROVIDER_ID } from './deepseek.js'
import { KIMI_PROVIDER_ID } from './kimi.js'
import { OLLAMA_PROVIDER_ID } from './ollama.js'

/** Provider identifier for Anthropic's own API — the default. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic' as const

/**
 * `apiProvider` is the {@link APIProvider} value each account resolves to. It is
 * typed as a plain string here rather than imported from utils/model/providers.js
 * to keep this module free of runtime imports; getAPIProvider's return type
 * pins it in practice.
 */
export const AUTH_PROVIDERS = [
  {
    id: ANTHROPIC_PROVIDER_ID,
    label: 'Anthropic',
    description: 'Claude Pro/Max subscription or Anthropic API key',
    apiProvider: 'firstParty',
  },
  {
    id: CODEX_PROVIDER_ID,
    label: 'OpenAI Codex',
    description: 'ChatGPT Plus/Pro subscription',
    apiProvider: 'openai',
  },
  {
    id: OLLAMA_PROVIDER_ID,
    label: 'Ollama',
    description: 'Local or self-hosted models via Ollama',
    apiProvider: 'ollama',
  },
  {
    id: DEEPSEEK_PROVIDER_ID,
    label: 'DeepSeek',
    description: 'DeepSeek R1 / V3 via API key (pay-per-token)',
    apiProvider: 'deepseek',
  },
  {
    id: KIMI_PROVIDER_ID,
    label: 'Kimi',
    description: 'Moonshot Kimi K3 / K2.7 via API key (pay-per-token)',
    apiProvider: 'kimi',
  },
] as const satisfies readonly {
  id: string
  label: string
  description: string
  apiProvider: string
}[]

export type AuthProviderId = (typeof AUTH_PROVIDERS)[number]['id']

/**
 * Used when nothing has been recorded — an unauthenticated first run, or a
 * config written by a build that predates the field. Anthropic is the right
 * assumption for both: it is what every pre-existing install was using.
 */
export const DEFAULT_AUTH_PROVIDER: AuthProviderId = ANTHROPIC_PROVIDER_ID

/**
 * Narrows an unknown config value to a known provider ID.
 *
 * Necessary because the value is read from a user-editable JSON file, so it may
 * be absent, misspelled, or name a provider a later version removed.
 *
 * @param value - A value read from config
 * @returns Whether it names a provider in the registry
 */
export function isAuthProviderId(value: unknown): value is AuthProviderId {
  return AUTH_PROVIDERS.some(provider => provider.id === value)
}

/**
 * Looks up a provider's registry entry.
 *
 * @param id - A provider ID
 * @returns The entry, including its label and API provider
 */
export function getAuthProviderInfo(
  id: AuthProviderId,
): (typeof AUTH_PROVIDERS)[number] {
  const provider = AUTH_PROVIDERS.find(entry => entry.id === id)
  // Unreachable for an AuthProviderId, but the find() type doesn't know that.
  return provider ?? AUTH_PROVIDERS[0]
}
