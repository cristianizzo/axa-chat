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
    // this field existed keeps working without a migration. Codex tokens can
    // only be there because the user chose Codex at the login prompt.
    return config.codexOAuth?.accessToken
      ? CODEX_PROVIDER_ID
      : DEFAULT_AUTH_PROVIDER
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
