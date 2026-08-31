/**
 * Which account the session is currently acting as.
 *
 * Separate from utils/auth.ts on purpose: getAPIProvider (utils/model/providers.ts)
 * needs this, and auth.ts already imports getAPIProvider. Keeping the resolution
 * here means providers.ts does not have to reach into auth.ts and pull the
 * keychain, OAuth refresh and analytics machinery along with it.
 *
 * Every provider-specific answer below comes from the descriptor registry
 * (config/providers), so this file has no per-provider branch left to forget to
 * extend.
 */

import {
  type AuthProviderId,
  DEFAULT_AUTH_PROVIDER,
  getProvider,
  getProviderModelCatalog,
  inferProviderFromCredentials,
  isAuthProviderId,
  isModelOwnedByACatalog,
} from '../config/providers/index.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { isModelAlias } from './model/aliases.js'

/**
 * Whether the given provider can serve the given concrete model ID.
 *
 * The provider-agnostic half of model.ts's isServableByActiveProvider, kept
 * here so the write path can validate without importing model.ts — which reads
 * this module, so the dependency would be a cycle. aliases.js is
 * dependency-free and safe to pull in.
 *
 * @param id - The provider to test
 * @param model - A concrete model ID, or an alias
 * @returns Whether that provider can serve it
 */
function isModelServableByProvider(id: AuthProviderId, model: string): boolean {
  // Aliases carry no provider; each provider resolves them to something it
  // serves. Only a concrete ID pins a provider, so only a concrete ID can be
  // wrong.
  if (isModelAlias(model)) {
    return true
  }
  const targetCatalog = getProviderModelCatalog(id)
  if (targetCatalog) {
    return targetCatalog.acceptsModel(model)
  }
  // No catalog of its own: it can serve anything except a model that
  // demonstrably belongs to another provider's catalog. A provider that pins
  // one exact model instead of listing a catalog (Ollama) never reaches here —
  // ownedModel returns above — so this stays a question about catalogs only.
  // Ownership rather than servability, so an ID another provider has retired
  // still counts as theirs and is not recorded against this one.
  return !isModelOwnedByACatalog(model)
}

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
    return getProvider(id).hasCredentials(getGlobalConfig())
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
    // this field existed keeps working without a migration.
    return inferProviderFromCredentials(config) ?? DEFAULT_AUTH_PROVIDER
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
 * A provider whose descriptor declares `ownedModel` keeps the choice in its own
 * credential record and is read from there; everything else stores it in the
 * shared `modelByAuthProvider` map. Returning undefined lets callers fall back
 * to the provider's default rather than leaking another account's model.
 *
 * @param id - The provider whose stored model to read
 * @returns The stored model id, or undefined
 */
export function getStoredModelForProvider(
  id: AuthProviderId,
): string | undefined {
  try {
    const config = getGlobalConfig()
    const owned = getProvider(id).ownedModel
    return owned ? owned(config) : config.modelByAuthProvider?.[id] || undefined
  } catch {
    return undefined
  }
}

/**
 * Remembers (or forgets) the model an account is using, so switching back to it
 * later restores that model instead of whatever the previous account left in
 * the session.
 *
 * A provider that owns its model is skipped: the value is set at login time and
 * changing it means logging in again, so writing the map would only create a
 * second answer that {@link getStoredModelForProvider} never reads. Passing
 * null clears the entry.
 *
 * A concrete ID the provider cannot serve is dropped rather than stored. The
 * caller records the *outgoing* session's model, which is only that account's
 * own choice when the session actually ran on it — on a login, or when the
 * switch happens before the session ever sampled the outgoing provider, the
 * value can be another provider's ID (this is how `claude-opus-5` ends up
 * recorded under `deepseek`).
 *
 * Today every reader re-checks servability, so a wrong entry is inert rather
 * than harmful. Dropping it here keeps that defence from being the only one:
 * the map means what it says, so a future reader that trusts it — model
 * display, or anything sizing a context window from the stored ID — cannot
 * silently inherit another provider's model. Aliases carry no provider and are
 * always safe to keep.
 *
 * @param id - The provider to record against
 * @param model - The model id to store, or null to forget it
 */
export function setStoredModelForProvider(
  id: AuthProviderId,
  model: string | null,
): void {
  if (getProvider(id).ownedModel) {
    return
  }
  if (model !== null && !isModelServableByProvider(id, model)) {
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
