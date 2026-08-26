/**
 * Which account the session is currently acting as.
 *
 * Separate from utils/auth.ts on purpose: getAPIProvider (utils/model/providers.ts)
 * needs this, and auth.ts already imports getAPIProvider. Keeping the resolution
 * here means providers.ts does not have to reach into auth.ts and pull the
 * keychain, OAuth refresh and analytics machinery along with it.
 */

import {
  type AuthProviderId,
  DEFAULT_AUTH_PROVIDER,
  isAuthProviderId,
} from '../config/authProviders.js'
import { CODEX_PROVIDER_ID } from '../config/codex.js'
import { DEEPSEEK_PROVIDER_ID } from '../config/deepseek.js'
import { KIMI_PROVIDER_ID } from '../config/kimi.js'
import { OLLAMA_PROVIDER_ID } from '../config/ollama.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

/**
 * True when credentials for the given provider are present on this machine.
 *
 * Only checks for presence, not validity or expiry — refreshing is each
 * provider's own concern. Used to decide which accounts `/switch-account` can
 * offer, and to infer the active provider when none was recorded.
 *
 * @param id - The provider to check
 * @returns Whether stored credentials exist for it
 */
export function hasCredentialsForAuthProvider(id: AuthProviderId): boolean {
  try {
    const config = getGlobalConfig()
    switch (id) {
      case CODEX_PROVIDER_ID:
        return !!config.codexOAuth?.accessToken
      case OLLAMA_PROVIDER_ID:
        // A local daemon ignores the token, so its presence proves nothing. A
        // completed Ollama login writes both the base URL and the chosen model;
        // require both so a half-written record isn't offered as an account.
        return !!config.ollamaAuth?.baseUrl && !!config.ollamaAuth?.model
      case DEEPSEEK_PROVIDER_ID:
        return !!config.deepseekAuth?.apiKey
      case KIMI_PROVIDER_ID:
        return !!config.kimiAuth?.apiKey
      default:
        // Anthropic tokens live in the keychain, not the config file, and
        // reading them is async and comparatively expensive. oauthAccount is
        // written by the same login that stores them, so it stands in for them.
        return !!config.oauthAccount || !!config.primaryApiKey
    }
  } catch {
    return false
  }
}

/**
 * The provider whose account this session is using.
 *
 * try/catch: callers include getAPIProvider, which runs while main.tsx builds
 * the Commander program — before enableConfigs(), where getGlobalConfig() throws
 * "Config accessed before allowed." No credentials can exist that early, so the
 * default is correct. Same swallow as bridgeEnabled.ts:94-99.
 *
 * @returns The active provider ID, defaulting to Anthropic
 */
export function getActiveAuthProvider(): AuthProviderId {
  try {
    const config = getGlobalConfig()
    if (isAuthProviderId(config.activeAuthProvider)) {
      return config.activeAuthProvider
    }
    // Nothing recorded: infer from what is stored, so a config written before
    // this field existed keeps working without a migration. Codex tokens or an
    // Ollama base URL can only be there because the user chose that provider at
    // the login prompt.
    if (config.codexOAuth?.accessToken) {
      return CODEX_PROVIDER_ID
    }
    if (config.ollamaAuth?.baseUrl && config.ollamaAuth?.model) {
      return OLLAMA_PROVIDER_ID
    }
    if (config.deepseekAuth?.apiKey) {
      return DEEPSEEK_PROVIDER_ID
    }
    if (config.kimiAuth?.apiKey) {
      return KIMI_PROVIDER_ID
    }
    return DEFAULT_AUTH_PROVIDER
  } catch {
    return DEFAULT_AUTH_PROVIDER
  }
}

/**
 * Records the provider a login authenticated, or that `/switch-account` selected.
 *
 * @param id - The provider now in use
 */
export function setActiveAuthProvider(id: AuthProviderId): void {
  saveGlobalConfig(config => ({ ...config, activeAuthProvider: id }))
}

/**
 * Forgets the active provider, so resolution falls back to whatever credentials
 * remain. Called on logout.
 */
export function clearActiveAuthProvider(): void {
  saveGlobalConfig(config => ({ ...config, activeAuthProvider: undefined }))
}

/**
 * The model this account last used, or undefined if it has none recorded.
 *
 * Ollama's model is authoritative in `ollamaAuth.model` (a login always writes
 * it), so it is read from there; every other provider stores its choice in the
 * `modelByAuthProvider` map. Returning undefined lets callers fall back to the
 * provider's default rather than leaking another account's model.
 *
 * @param id - The provider whose stored model to read
 * @returns The stored model id, or undefined
 */
export function getStoredModelForProvider(
  id: AuthProviderId,
): string | undefined {
  try {
    const config = getGlobalConfig()
    if (id === OLLAMA_PROVIDER_ID) {
      return config.ollamaAuth?.model || undefined
    }
    return config.modelByAuthProvider?.[id] || undefined
  } catch {
    return undefined
  }
}

/**
 * Remembers (or forgets) the model an account is using, so switching back to it
 * later restores that model instead of whatever the previous account left in
 * the session.
 *
 * Ollama's model is owned by `ollamaAuth.model` and is not touched here — it is
 * set at login time and changing it means re-logging in — so this only writes
 * the map for the other providers. Passing null clears the entry.
 *
 * @param id - The provider to record against
 * @param model - The model id to store, or null to forget it
 */
export function setStoredModelForProvider(
  id: AuthProviderId,
  model: string | null,
): void {
  if (id === OLLAMA_PROVIDER_ID) {
    return
  }
  saveGlobalConfig(config => {
    const next = { ...(config.modelByAuthProvider ?? {}) }
    if (model === null) {
      delete next[id]
    } else {
      next[id] = model
    }
    return { ...config, modelByAuthProvider: next }
  })
}
