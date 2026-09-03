/**
 * How each account provider configures the Anthropic SDK client.
 *
 * Every provider other than Anthropic reaches its backend by handing the SDK a
 * different `fetch`, a different `baseURL`, or both. Those four setups used to
 * be four near-identical `if` blocks inside `getAnthropicClient`, and the cost
 * of that showed: `getMaxConcurrentRequests` had exactly one call site, buried
 * in the Kimi block, so any other provider that declared a concurrency limit in
 * its catalog was silently ignored. Here the limiter is applied once, to the
 * fetch every builder is handed, and a provider cannot opt out of it by
 * forgetting to opt in.
 *
 * Deliberately not a field on `ProviderDescriptor`. The descriptors under
 * `config/providers/` are imported by the `/login` picker, the model picker and
 * the footer, and are dependency-free on purpose; putting `createCodexFetch`
 * there would pull 1500 lines of SSE translation and the Anthropic SDK into all
 * of them. The exhaustive `Record` below buys the same compile-time
 * completeness without that cost — a new provider that has no entry fails the
 * build.
 */

import { CODEX_PROVIDER_ID } from 'src/config/codex.js'
import { DEEPSEEK_PROVIDER_ID } from 'src/config/deepseek.js'
import { GROK_PROVIDER_ID } from 'src/config/grok.js'
import { KIMI_BASE_URL, KIMI_PROVIDER_ID } from 'src/config/kimi.js'
import { OLLAMA_PROVIDER_ID } from 'src/config/ollama.js'
import {
  ANTHROPIC_PROVIDER_ID,
  type AuthProviderId,
  getMaxConcurrentRequests,
} from 'src/config/providers/index.js'
import {
  getCodexOAuthTokens,
  getDeepSeekAuth,
  getGrokAuth,
  getKimiAuth,
  getOllamaAuth,
} from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { createCodexFetch } from './codex-fetch-adapter.js'
import { createCountTokensShim } from './count-tokens-shim.js'
import { createDeepSeekFetch } from './deepseek-fetch-adapter.js'
import { createGrokFetch } from './grok-fetch-adapter.js'
import { limitRequestConcurrency } from './requestLimiter.js'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * The parts of the SDK client config a provider decides for itself.
 *
 * Everything else — headers, timeout, retries, proxy options — is shared, and
 * `getAnthropicClient` merges this on top of it.
 */
export type ProviderClientConfig = {
  /** `null` when auth travels as a Bearer token or is handled by `fetch`. */
  apiKey: string | null

  /** Sent as `Authorization: Bearer`, for backends that document that form. */
  authToken?: string

  /**
   * Set only when the SDK itself must talk to a non-Anthropic host.
   *
   * Doubles as the signal to drop `Authorization` from the shared default
   * headers: that header carries ANTHROPIC_AUTH_TOKEN or the apiKeyHelper's
   * output, and `defaultHeaders` outrank the SDK's own auth, so leaving it
   * would both break the request and hand a third party a key meant for
   * Anthropic. Providers that intercept at the fetch layer instead leave this
   * undefined — their `baseURL` stays Anthropic's, and requests they do not
   * translate are supposed to carry that credential.
   */
  baseURL?: string

  /** The fetch the SDK should use. */
  fetch: FetchFn
}

/**
 * Builds the config, or returns undefined when the credential is missing.
 *
 * Undefined is a real case rather than an impossible one: the provider is
 * chosen from config, and the credential can be cleared by a `/logout` in
 * another terminal between that check and this call.
 *
 * @param base - The shared fetch, already concurrency-limited for this provider
 */
type ProviderClientBuilder = (base: FetchFn) => ProviderClientConfig | undefined

/**
 * Total on purpose: a provider added to the registry with no entry here is a
 * compile error rather than an account that quietly gets the default Anthropic
 * client. (An entry that returns undefined at runtime does fall back to that
 * client — but only after logging why, and only because its credential really
 * has gone missing, which is a state the user has to be told about.)
 *
 * Anthropic is `null` because it needs no override — `getAnthropicClient`'s
 * final block is its configuration, and it is the one that reads the keychain.
 */
const PROVIDER_CLIENT_BUILDERS: Record<
  AuthProviderId,
  ProviderClientBuilder | null
> = {
  [ANTHROPIC_PROVIDER_ID]: null,

  [CODEX_PROVIDER_ID]: base => {
    const accessToken = getCodexOAuthTokens()?.accessToken
    if (!accessToken) {
      return undefined
    }
    return {
      // The SDK insists on a key; the fetch adapter is what actually
      // authenticates, using the OAuth token above.
      apiKey: 'codex-placeholder',
      fetch: createCodexFetch(accessToken, base),
    }
  },

  [OLLAMA_PROVIDER_ID]: base => {
    const ollama = getOllamaAuth()
    if (!ollama?.baseUrl) {
      return undefined
    }
    return {
      apiKey: null,
      // A local daemon ignores the token, so any non-empty placeholder works;
      // Ollama Cloud expects a real one. It is sent as `Authorization: Bearer`,
      // which is what the SDK's `authToken` produces.
      authToken: ollama.authToken || 'ollama',
      baseURL: ollama.baseUrl,
      // The daemon has no count_tokens endpoint; answer that one path locally.
      fetch: createCountTokensShim(base),
    }
  },

  [DEEPSEEK_PROVIDER_ID]: base => {
    const apiKey = getDeepSeekAuth()?.apiKey
    if (!apiKey) {
      return undefined
    }
    return {
      apiKey: 'deepseek-placeholder',
      fetch: createDeepSeekFetch(apiKey, base),
    }
  },

  [KIMI_PROVIDER_ID]: base => {
    const apiKey = getKimiAuth()?.apiKey
    if (!apiKey) {
      return undefined
    }
    return {
      apiKey: null,
      // `authToken`, not `apiKey`: ANTHROPIC_AUTH_TOKEN — the Bearer header —
      // is what Moonshot documents for this endpoint. Probing the live API
      // shows it also accepts `x-api-key` (what the SDK's `apiKey` emits), and
      // accepts both at once, so this follows the documented contract rather
      // than working around something that fails today. `apiKey: null` then
      // stops the SDK adding the undocumented header alongside it.
      authToken: apiKey,
      baseURL: KIMI_BASE_URL,
      // Moonshot's shim implements messages, not count_tokens; answer that one
      // path locally exactly as the Ollama daemon requires. The shim goes
      // outside the limiter — `base` is already limited — so a locally-answered
      // count_tokens never waits for, or occupies, one of the few slots
      // Moonshot gives us.
      fetch: createCountTokensShim(base),
    }
  },

  [GROK_PROVIDER_ID]: base => {
    const apiKey = getGrokAuth()?.apiKey
    if (!apiKey) {
      return undefined
    }
    return {
      // The SDK insists on a key; the fetch adapter is what actually
      // authenticates, sending the real key as `Authorization: Bearer` to
      // api.x.ai. Mirror of DeepSeek's placeholder.
      apiKey: 'grok-placeholder',
      fetch: createGrokFetch(apiKey, base),
    }
  },
}

/**
 * The SDK client config for a provider, or undefined when it needs no override
 * (Anthropic) or its credential has gone missing.
 *
 * @param provider - The active account provider
 * @param base - The shared fetch, before any per-provider wrapping
 * @returns The config to merge over the shared client options
 */
export function buildProviderClientConfig(
  provider: AuthProviderId,
  base: FetchFn,
): ProviderClientConfig | undefined {
  const build = PROVIDER_CLIENT_BUILDERS[provider]
  if (!build) {
    return undefined
  }
  const maxConcurrent = getMaxConcurrentRequests(provider)
  const config = build(
    maxConcurrent
      ? limitRequestConcurrency(provider, maxConcurrent, base)
      : base,
  )
  if (!config) {
    logForDebugging(
      `${provider} is the active account but its credential is missing; falling back to the default client, which will surface an auth error`,
      { level: 'warn' },
    )
  }
  return config
}
