/**
 * What the rest of the CLI needs to know about an account provider.
 *
 * One descriptor per provider, assembled in the sibling files and collected into
 * the exhaustive `PROVIDERS` record in ./index.ts. The point of gathering these
 * fields into a single type is that a new provider becomes a compile error until
 * every one of them is answered — previously the answers were spread across a
 * login picker, a credential switch, a logout chain, a model-storage special
 * case and a fetch-client if-ladder, and adding a provider meant finding all of
 * them by hand. The Kimi commit (269271b) touched 18 files for exactly that
 * reason, and still missed `getMaxConcurrentRequests`, which had one call site.
 *
 * Deliberately data-only. Every function here is pure and takes the config it
 * reads as an argument, so this module imports nothing at runtime beyond the
 * sibling `config/*.ts` constant modules, which are themselves dependency-free.
 * That matters because the importers span the whole dependency graph — the
 * `/login` picker, the networking layer, the model picker, `/logout` — and a
 * runtime import of `utils/auth.js` or `utils/config.js` here would either
 * cycle or drag the keychain into a module whose job is to list model names.
 * `GlobalConfig` and `APIProvider` are imported `type`-only for the same reason.
 */

import type { GlobalConfig } from '../../utils/config.js'
import type { APIProvider } from '../../utils/model/providers.js'
import type { ProviderModelCatalog } from './catalog.js'

/**
 * How `/logout` disposes of a provider's credentials.
 *
 * A union rather than an optional callback so that a new provider has to state
 * which kind it is. The two kinds are genuinely different: everything except
 * Anthropic keeps its secret in one `GlobalConfig` key and logging out is a
 * pure edit of that object, while Anthropic's tokens live in the OS keychain
 * and its logout additionally wipes secure storage, resets onboarding and
 * flushes telemetry before the credentials go.
 */
export type ProviderLogout =
  /** The credential is a single config key; dropping it is the whole logout. */
  | {
      kind: 'configKey'
      message: string
      clearCredentials: (config: GlobalConfig) => GlobalConfig
    }
  /** Credentials are in the keychain; `performLogout()` owns the sequence. */
  | { kind: 'anthropicKeychain'; message: string }

/**
 * What `/login` needs in order to run an API-key prompt for a provider.
 *
 * Present only for providers whose whole login is "paste a key": the Anthropic
 * and Codex flows are browser OAuth, and Ollama's is a model picker against a
 * daemon that is already signed in. The prompt used to be copied per provider
 * in ConsoleOAuthFlow — the DeepSeek and Kimi cases were identical but for four
 * strings and one setter — so a third key-based provider meant a third copy.
 *
 * `storeCredentials` follows {@link ProviderLogout}'s `clearCredentials`: a pure
 * edit of the config it is handed, so this module still imports nothing at
 * runtime.
 */
export type ProviderApiKeyLogin = {
  /** Bold heading above the input, e.g. 'Enter your DeepSeek API key:'. */
  prompt: string

  /** Dim line under it saying where to get a key. */
  hint: string

  /** Shown when the entered value fails {@link API_KEY_PATTERN}. */
  invalidMessage: string

  /** Writes the key into the config, leaving every other provider's alone. */
  storeCredentials: (config: GlobalConfig, apiKey: string) => GlobalConfig
}

/**
 * What both key-based providers accepted before this was shared: printable
 * ASCII, 8–512 characters. Deliberately loose — it exists to catch a pasted URL
 * or an empty clipboard, not to validate a key the server has yet to see.
 */
export const API_KEY_PATTERN = /^[\x21-\x7E]{8,512}$/

/**
 * Generic in the ID so the registry can present the same descriptors two ways:
 * each file declares its own literal ID (which is what derives the
 * `AuthProviderId` union), while `ALL_PROVIDERS` and `PROVIDERS` re-type them as
 * `ProviderDescriptor<AuthProviderId>` — narrow enough that `.id` still type-checks
 * as a provider ID, wide enough that the optional fields exist on every element.
 */
export type ProviderDescriptor<Id extends string = string> = {
  /** Stable identifier, persisted in config as `activeAuthProvider`. */
  id: Id

  /** Shown in the `/login` and `/switch-account` pickers. */
  label: string

  /** One-line explanation of what logging in with this account gets you. */
  description: string

  /**
   * The backend requests resolve to. Cloud deployments (Bedrock/Vertex/Foundry)
   * override this from the environment — see getAPIProvider — so this is the
   * value that applies when no such override is set.
   */
  apiProvider: APIProvider

  /**
   * Extra names `/switch-account <arg>` accepts, beyond {@link id}. Lower-case;
   * the argument is lower-cased before lookup.
   */
  aliases: readonly string[]

  /**
   * Whether credentials for this provider are present on this machine.
   *
   * Presence only — validity and expiry are each provider's own concern. Used
   * to decide which accounts `/switch-account` offers and, when no active
   * provider was recorded, to infer one.
   */
  hasCredentials: (config: GlobalConfig) => boolean

  /** How `/logout` disposes of those credentials. */
  logout: ProviderLogout

  /**
   * An identifying detail for this account, when the login gives us one worth
   * showing: Anthropic stores an email, Ollama records the single model it
   * serves. Omitted where the flow yields nothing but an opaque ID (Codex) or
   * nothing at all (an API key), and the label alone identifies the account.
   */
  accountDetail?: (config: GlobalConfig) => string | undefined

  /**
   * Reads the model choice out of the credential record, for providers that
   * own it there.
   *
   * Present means the credentials are authoritative and the shared
   * `modelByAuthProvider` map must not be written for this provider — Ollama's
   * model is fixed at login and changing it means logging in again. Absent
   * means the map holds it, read and write.
   */
  ownedModel?: (config: GlobalConfig) => string | undefined

  /**
   * The API-key prompt `/login` runs for this provider, when that is its whole
   * login. Absent for the OAuth and daemon-backed flows.
   */
  apiKeyLogin?: ProviderApiKeyLogin

  /**
   * This provider's model catalog, when its full set of models is known
   * locally.
   *
   * Absent for Anthropic, whose catalog comes from the capability registry and
   * the subscription state, and for Ollama, whose one model is discovered at
   * login.
   */
  catalog?: ProviderModelCatalog
}
