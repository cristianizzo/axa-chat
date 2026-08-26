import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getAuthProviderInfo } from '../../config/authProviders.js'
import { getActiveAuthProvider } from '../activeAuthProvider.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai' | 'ollama' | 'deepseek' | 'kimi'

/**
 * The API backend requests are served by.
 *
 * The cloud providers stay env-driven: they are deployment configuration set by
 * an operator, with no interactive login to record a choice. Everything else
 * follows the account the user logged in with, so picking a ChatGPT account at
 * the `/login` prompt is enough to route to OpenAI — there is deliberately no
 * CLAUDE_CODE_USE_OPENAI flag to also remember to set.
 *
 * @returns The provider to send requests to
 */
export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    return 'bedrock'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    return 'vertex'
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    return 'foundry'
  }
  return getAuthProviderInfo(getActiveAuthProvider()).apiProvider
}

/**
 * Whether the logged-in account is the thing actually serving requests.
 *
 * False when CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY is set, because those
 * win in getAPIProvider() above and in getAnthropicClient(), which returns a
 * cloud client before it ever reaches the per-account branches. The account
 * still exists and still names a model, so anything reading a provider catalog
 * to answer "what model can I send" or "what does this endpoint accept" has to
 * check this first — the catalog describes the account, not the backend that
 * would receive the request.
 *
 * @returns Whether account-derived capabilities apply to outgoing requests
 */
export function isActiveAccountServingRequests(): boolean {
  return (
    getAPIProvider() === getAuthProviderInfo(getActiveAuthProvider()).apiProvider
  )
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
