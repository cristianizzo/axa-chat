import * as React from 'react'
import { useEffect, useState } from 'react'
import { getProvider } from 'src/config/providers/index.js'
import { useAppState } from 'src/state/AppState.js'
import { DEEPSEEK_BASE_URL } from '../../config/deepseek.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { getActiveAuthProvider } from '../../utils/activeAuthProvider.js'
import { getDeepSeekAuth, isDeepSeekSubscriber } from '../../utils/auth.js'
import { isActiveAccountServingRequests } from '../../utils/model/providers.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

/**
 * The account serving the session, as a single pill in the footer's left bar:
 *
 *   DeepSeek - deepseek-v4-flash - $7.12
 *
 * Combines the active provider, its model, and — only when a DeepSeek account
 * is serving — the remaining credit, since the balance is the one piece of that
 * trio the LLM endpoint never echoes (it lives at `GET /user/balance`).
 *
 * Re-renders on account switch by subscribing to AppState `authVersion`, which
 * `/switch-account` bumps, and the model via `useMainLoopModel`.
 */
const REFRESH_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

// DeepSeek reports the currency as an ISO code; map the common ones to a
// symbol so the pill stays short. Anything unmapped falls back to the code.
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
  SGD: 'S$',
  KRW: '₩',
}

type DeepSeekBalanceInfo = {
  currency: string
  total_balance: string
}

type BalanceResponse = {
  is_available: boolean
  balance_infos: DeepSeekBalanceInfo[]
}

function formatAmount(entry: DeepSeekBalanceInfo): string {
  const amount = parseFloat(entry.total_balance)
  if (!Number.isFinite(amount)) return `${entry.currency} ${entry.total_balance}`
  const symbol = CURRENCY_SYMBOLS[entry.currency] ?? `${entry.currency} `
  return `${symbol}${amount.toFixed(2)}`
}

function useDeepSeekBalance(): string | null {
  const [balance, setBalance] = useState<string | null>(null)
  // Re-run when the account switches so polling starts/tears down with the
  // active provider instead of staying frozen from mount.
  const authVersion = useAppState(s => s.authVersion)

  useEffect(() => {
    if (!isDeepSeekSubscriber()) {
      setBalance(null)
      return
    }

    // Stops a response resolving after the effect has torn down (account
    // switched) from writing a stale balance into state.
    let cancelled = false

    async function load(): Promise<void> {
      const auth = getDeepSeekAuth()
      if (!auth?.apiKey) {
        if (!cancelled) setBalance(null)
        return
      }
      // A fresh controller per request: the timeout must abort only the
      // in-flight call, never the ones that follow it.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
          headers: { Authorization: `Bearer ${auth.apiKey}` },
          signal: controller.signal,
          ...getProxyFetchOptions({ forAnthropicAPI: false }),
        })
        // The provider may have changed while the request was in flight; only
        // commit the response if DeepSeek is still the active subscriber.
        if (cancelled || !isDeepSeekSubscriber()) {
          setBalance(null)
          return
        }
        if (!response.ok) {
          setBalance(null)
          return
        }
        const body = (await response.json()) as BalanceResponse
        if (!body.is_available || !body.balance_infos?.length) {
          setBalance(null)
          return
        }
        setBalance(body.balance_infos.map(formatAmount).join(' + '))
      } catch {
        // Network/proxy/timeout: stay silent and retry on the next tick
        // rather than flashing an error in the footer.
        if (!cancelled) setBalance(null)
      } finally {
        clearTimeout(timeout)
      }
    }

    void load()
    const interval = setInterval(() => void load(), REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [authVersion])

  return balance
}

export function ActiveAccount({
  separator = false,
}: {
  /** Render a trailing ` · ` so the pill reads as part of a joined row. */
  separator?: boolean
}): React.ReactNode {
  useAppState(s => s.authVersion)
  const model = useMainLoopModel()
  const balance = useDeepSeekBalance()

  // Same guard as the banner's provider line: when CLAUDE_CODE_USE_BEDROCK/
  // _VERTEX/_FOUNDRY is set, the logged-in account is not the backend serving
  // requests, and naming it would be misleading.
  if (!isActiveAccountServingRequests()) {
    return null
  }

  const provider = getProvider(getActiveAuthProvider())
  const label = provider.shortLabel ?? provider.label

  const parts = [label, model]
  // Render-time guard on top of the hook's: a stale balance must not leak onto
  // the pill after an account switch (the hook clears it, but never trust
  // state a switch races against).
  if (balance && isDeepSeekSubscriber()) parts.push(balance)

  return (
    <Text dimColor wrap="truncate">
      {parts.join(' - ')}
      {separator ? ' · ' : ''}
    </Text>
  )
}
