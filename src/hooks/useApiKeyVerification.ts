import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/claude.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
} from '../utils/auth.js'
import { isServedByAnthropic } from '../utils/model/providers.js'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

/**
 * Whether this session needs an Anthropic API key at all.
 *
 * Everything here verifies one specific credential: an Anthropic API key. A
 * session that will not send one has nothing to verify, and reporting 'missing'
 * for it puts a permanent red "Not logged in · Run /login" in the footer
 * (Notifications.tsx) of a session that is working perfectly well.
 *
 * `isServedByAnthropic()` is what makes this exhaustive. The list it replaces
 * named claude.ai and Codex one by one, so every provider added afterwards —
 * Ollama, DeepSeek, Kimi — inherited the false warning, and the next one would
 * have too. Asking where the request is going covers them all, including the
 * cloud backends, without an entry per provider.
 */
function requiresAnthropicApiKey(): boolean {
  return isAnthropicAuthEnabled() && isServedByAnthropic() && !isClaudeAISubscriber()
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    if (!requiresAnthropicApiKey()) {
      return 'valid'
    }
    // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
    // before trust dialog is shown (security: prevents RCE via settings.json)
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // If apiKeyHelper is configured, we have a key source even though we
    // haven't executed it yet - return 'loading' to indicate we'll verify later
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  const [error, setError] = useState<Error | null>(null)

  const verify = useCallback(async (): Promise<void> => {
    if (!requiresAnthropicApiKey()) {
      // Clear the error too. `verify` is re-run on every credential change
      // (`/switch-account`, `/login`, `/upgrade` all call onChangeAPIKey), so a
      // session that failed verification under an Anthropic key and then
      // switched to Ollama would otherwise keep the dead key's error alongside
      // a 'valid' status.
      setStatus('valid')
      setError(null)
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    const { key: apiKey, source } = getAnthropicApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }

    try {
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}
