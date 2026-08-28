import axios from 'axios'
import React, { useEffect, useState } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { PressEnterToContinue } from '../components/PressEnterToContinue.js'
import { Spinner } from '../components/Spinner.js'
import { getOauthConfig } from '../constants/oauth.js'
import { useTimeout } from '../hooks/useTimeout.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getSSLErrorHint } from '../services/api/errorUtils.js'
import { getErrnoCode } from './errors.js'
import { getUserAgent } from './http.js'
import { logError } from './log.js'

export interface PreflightCheckResult {
  success: boolean
  error?: string
  sslHint?: string
}

async function checkEndpoints(): Promise<PreflightCheckResult> {
  try {
    const oauthConfig = getOauthConfig()
    const tokenUrl = new URL(oauthConfig.TOKEN_URL)
    const endpoints = [
      `${oauthConfig.BASE_API_URL}/api/hello`,
      `${tokenUrl.origin}/v1/oauth/hello`,
    ]

    const checkEndpoint = async (
      url: string,
    ): Promise<PreflightCheckResult> => {
      try {
        const response = await axios.get(url, {
          headers: { 'User-Agent': getUserAgent() },
        })
        if (response.status !== 200) {
          const hostname = new URL(url).hostname
          return {
            success: false,
            error: `Failed to connect to ${hostname}: Status ${response.status}`,
          }
        }
        return { success: true }
      } catch (error) {
        const hostname = new URL(url).hostname
        const sslHint = getSSLErrorHint(error)
        return {
          success: false,
          error: `Failed to connect to ${hostname}: ${error instanceof Error ? getErrnoCode(error) || error.message : String(error)}`,
          sslHint: sslHint ?? undefined,
        }
      }
    }

    const results = await Promise.all(endpoints.map(checkEndpoint))
    const failedResult = results.find(result => !result.success)

    if (failedResult) {
      logEvent('tengu_preflight_check_failed', {
        isConnectivityError: false,
        hasErrorMessage: !!failedResult.error,
        isSSLError: !!failedResult.sslHint,
      })
    }

    return failedResult || { success: true }
  } catch (error) {
    logError(error as Error)

    logEvent('tengu_preflight_check_failed', {
      isConnectivityError: true,
    })

    return {
      success: false,
      error: `Connectivity check error: ${error instanceof Error ? getErrnoCode(error) || error.message : String(error)}`,
    }
  }
}

interface PreflightStepProps {
  onSuccess: () => void
}

/**
 * First onboarding step: can this machine reach Anthropic?
 *
 * The check is Anthropic-specific — it pings the OAuth and API hosts from
 * `getOauthConfig()`. It used to `process.exit(1)` when they were unreachable,
 * which made sense upstream where Anthropic was the only backend. Here it is
 * one of five: a failure now blocks onboarding for someone who came to run a
 * local Ollama model, or to sign in with Codex, DeepSeek or Kimi, none of
 * which touch these hosts. Worse, it fails closed on any offline install.
 *
 * So the result is reported and the user decides. A reachable Anthropic still
 * advances automatically, exactly as before — nobody who was unaffected by the
 * old behaviour sees an extra keypress.
 */
export function PreflightStep({
  onSuccess,
}: PreflightStepProps): React.ReactNode {
  const [result, setResult] = useState<PreflightCheckResult | null>(null)
  const [isChecking, setIsChecking] = useState(true)

  // delay showing the check since it's so fast that we normally
  // want to just immediately show the next step without a flash
  const showSpinner = useTimeout(1000) && isChecking

  const failed = !!result && !result.success

  useEffect(() => {
    async function run() {
      const checkResult = await checkEndpoints()
      setResult(checkResult)
      setIsChecking(false)
    }
    void run()
  }, [])

  useEffect(() => {
    if (result?.success) {
      onSuccess()
    }
  }, [result, onSuccess])

  useKeybinding('confirm:yes', onSuccess, {
    context: 'Confirmation',
    isActive: failed,
  })

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      {isChecking && showSpinner ? (
        <Box paddingLeft={1}>
          <Spinner />
          <Text>Checking connectivity...</Text>
        </Box>
      ) : (
        failed && (
          <Box flexDirection="column" gap={1}>
            <Text color="error">Unable to connect to Anthropic services</Text>
            <Text color="error">{result?.error}</Text>
            {result?.sslHint ? (
              <Text>{result.sslHint}</Text>
            ) : (
              <Text>
                Please check your internet connection and network settings.
              </Text>
            )}
            <Text dimColor>
              This only affects signing in with a Claude account. Codex,
              Ollama, DeepSeek and Kimi do not use these hosts, so you can
              continue and pick one of those instead.
            </Text>
            <PressEnterToContinue />
          </Box>
        )
      )}
    </Box>
  )
}
