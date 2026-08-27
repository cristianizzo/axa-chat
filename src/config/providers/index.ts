/**
 * The registry of accounts a user can log in with.
 *
 * Exists because "which provider am I talking to" used to be answered purely by
 * environment variables (CLAUDE_CODE_USE_BEDROCK and friends). That works for
 * cloud deployments, where an operator sets the env once, but not for
 * subscription logins: a user who runs `/login` and picks their ChatGPT account
 * should get the OpenAI backend without also having to export a flag. So the
 * login records which provider it authenticated, and this table says what that
 * means.
 *
 * Adding a provider is two files: its constants under `config/<id>.ts`, and its
 * descriptor here. Registering it in {@link ALL_PROVIDERS} is what makes the
 * compiler demand the rest — {@link PROVIDERS} is a total `Record`, not a
 * `Partial` and not an array, so a provider that is listed but not described
 * fails the build, and every consumer that switches over a provider ID gets an
 * exhaustiveness error rather than silently falling back to Anthropic's answer.
 *
 * Dependency-free at runtime apart from the sibling `config/*.ts` constant
 * modules, which are themselves dependency-free — see the note in ./types.ts.
 */

import type { GlobalConfig } from '../../utils/config.js'
import { CODEX_PROVIDER_ID } from '../codex.js'
import { DEEPSEEK_PROVIDER_ID } from '../deepseek.js'
import { KIMI_PROVIDER_ID } from '../kimi.js'
import { OLLAMA_PROVIDER_ID } from '../ollama.js'
import { ANTHROPIC_PROVIDER, ANTHROPIC_PROVIDER_ID } from './anthropic.js'
import type { ProviderModelCatalog } from './catalog.js'
import { CODEX_PROVIDER } from './codex.js'
import { DEEPSEEK_PROVIDER } from './deepseek.js'
import { KIMI_PROVIDER } from './kimi.js'
import { OLLAMA_PROVIDER } from './ollama.js'
import type { ProviderDescriptor } from './types.js'

export { ANTHROPIC_PROVIDER_ID } from './anthropic.js'
export type {
  ProviderModelCatalog,
  ProviderModelOption,
} from './catalog.js'
export { API_KEY_PATTERN } from './types.js'
export type {
  ProviderApiKeyLogin,
  ProviderDescriptor,
  ProviderLogout,
} from './types.js'

/**
 * Every provider, in the order the `/login` and `/switch-account` pickers show
 * them. Anthropic first because it is the default and the common case.
 *
 * Kept in its literal form so the ID union below can be read off it; the
 * exported view is widened just underneath.
 */
const PROVIDER_TUPLE = [
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  OLLAMA_PROVIDER,
  DEEPSEEK_PROVIDER,
  KIMI_PROVIDER,
] as const satisfies readonly ProviderDescriptor[]

/**
 * The IDs, read off the constants rather than off {@link PROVIDER_TUPLE}.
 *
 * Deriving them from the descriptors would be tidier but does not typecheck:
 * `GlobalConfig.activeAuthProvider` is an `AuthProviderId`, and the descriptors
 * take and return a `GlobalConfig`, so inferring their types in order to read
 * `.id` is circular. The ID constants live in the dependency-free
 * `config/*.ts` modules and reference nothing, which breaks the loop.
 *
 * Nothing is lost: {@link PROVIDERS} is a total `Record` over this union whose
 * keys are the descriptors' own `.id`s, so a tuple and a list that disagree is
 * still a compile error.
 */
const PROVIDER_IDS = [
  ANTHROPIC_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  KIMI_PROVIDER_ID,
] as const

export type AuthProviderId = (typeof PROVIDER_IDS)[number]

/** {@link PROVIDER_TUPLE}, in the type callers iterate. */
export const ALL_PROVIDERS: readonly ProviderDescriptor<AuthProviderId>[] =
  PROVIDER_TUPLE

/**
 * The same descriptors, keyed for lookup.
 *
 * A total `Record` on purpose: it is the one line that makes an unfinished
 * provider a compile error instead of a runtime surprise.
 */
export const PROVIDERS: Record<
  AuthProviderId,
  ProviderDescriptor<AuthProviderId>
> = {
  [ANTHROPIC_PROVIDER.id]: ANTHROPIC_PROVIDER,
  [CODEX_PROVIDER.id]: CODEX_PROVIDER,
  [OLLAMA_PROVIDER.id]: OLLAMA_PROVIDER,
  [DEEPSEEK_PROVIDER.id]: DEEPSEEK_PROVIDER,
  [KIMI_PROVIDER.id]: KIMI_PROVIDER,
}

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
  return typeof value === 'string' && value in PROVIDERS
}

/**
 * Looks up a provider's descriptor.
 *
 * Total, unlike the `find()` it replaces: {@link PROVIDERS} has an entry for
 * every {@link AuthProviderId}, so there is no missing case to paper over with
 * a fallback to Anthropic's descriptor.
 *
 * @param id - A provider ID
 * @returns Its descriptor
 */
export function getProvider(
  id: AuthProviderId,
): ProviderDescriptor<AuthProviderId> {
  return PROVIDERS[id]
}

/**
 * Resolves a `/switch-account <arg>` argument to a provider.
 *
 * Matches the ID first and then the provider's declared aliases, so the short
 * names live beside the provider they name rather than in a separate table that
 * a new provider is easy to leave out of.
 *
 * @param arg - The raw argument the user typed
 * @returns The provider ID, or undefined if nothing matches
 */
export function resolveProviderAlias(arg: string): AuthProviderId | undefined {
  const needle = arg.trim().toLowerCase()
  if (!needle) {
    return undefined
  }
  const match = ALL_PROVIDERS.find(
    provider => provider.id === needle || provider.aliases.includes(needle),
  )
  return match?.id
}

/**
 * The provider whose credentials are present, when none was explicitly
 * recorded.
 *
 * The default is deliberately not a candidate: it is the fallback, and treating
 * it as one would mean a config written before `activeAuthProvider` existed —
 * which can hold Anthropic and Codex credentials at once — resolved to whichever
 * came first in the list rather than to the third-party account the user was
 * actually using.
 *
 * @param config - The global config to inspect
 * @returns The inferred provider ID, or undefined if only the default's
 *   credentials (or none) are present
 */
export function inferProviderFromCredentials(
  config: GlobalConfig,
): AuthProviderId | undefined {
  const match = ALL_PROVIDERS.find(
    provider =>
      provider.id !== DEFAULT_AUTH_PROVIDER && provider.hasCredentials(config),
  )
  return match?.id
}

/**
 * A provider's model catalog, or undefined when its models are not known
 * locally (Anthropic, Ollama).
 *
 * @param provider - The provider to look up
 * @returns Its catalog, if it has one
 */
export function getProviderModelCatalog(
  provider: AuthProviderId,
): ProviderModelCatalog | undefined {
  return PROVIDERS[provider].catalog
}

/**
 * Requests allowed in flight at once for a provider, honouring the operator
 * override.
 *
 * @param provider - The account provider serving requests
 * @returns The limit, or undefined when the provider needs no limiting
 */
export function getMaxConcurrentRequests(
  provider: AuthProviderId,
): number | undefined {
  const catalogLimit = getProviderModelCatalog(provider)?.maxConcurrentRequests
  if (catalogLimit === undefined) {
    return undefined
  }
  const override = parseInt(
    process.env.CLAUDE_CODE_MAX_CONCURRENT_REQUESTS || '',
    10,
  )
  return override > 0 ? override : catalogLimit
}

/**
 * The catalog that claims a given model ID.
 *
 * @param model - A model ID
 * @returns The owning catalog, or undefined if no local catalog accepts it
 */
export function getProviderModelCatalogForModel(
  model: string,
): ProviderModelCatalog | undefined {
  return ALL_PROVIDERS.find(provider =>
    provider.catalog?.acceptsModel(model),
  )?.catalog
}
