import * as React from 'react'
import { useEffect, useState } from 'react'
import { DEEPSEEK_BASE_URL } from '../../config/deepseek.js'
import { Text } from '../../ink.js'
import { useAppState } from 'src/state/AppState.js'
import { getDeepSeekAuth, isDeepSeekSubscriber } from '../../utils/auth.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

/**
 * DeepSeek account balance, shown in the footer's right bar while a DeepSeek
 * account is serving the session.
 *
 * DeepSeek's API exposes the remaining credit at `GET /user/balance`, which the
 * LLM endpoint has no reason to echo, so the usual "cost of the last response"
 * has no per-call signal to anchor to. This fetches it directly with the stored
 * API key and refreshes it on a timer while the account is active.
 *
 * The effect subscribes to AppState `authVersion`, which `/switch-account`
 * bumps, so it tears down when DeepSeek stops being the active provider and
 * restarts when it becomes active again.
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

function formatEntry(entry: DeepSeekBalanceInfo): string {
  const amount = parseFloat(entry.total_balance)
  if (!Number.isFinite(amount)) return `${entry.currency} ${entry.total_balance}`
  const symbol = CURRENCY_SYMBOLS[entry.currency] ?? `${entry.currency} `
  return `${symbol}${amount.toFixed(2)}`
}

export function DeepSeekBalance({
  separator = false,
}: {
  /** Render a trailing ` ·` so the pill reads as part of a joined row. */
  separator?: boolean
}): React.ReactNode {
  const [label, setLabel] = useState<string | null>(null)
  // Re-run the effect when the account switches so polling starts/tears down
  // with the active provider instead of staying frozen from mount.
  const authVersion = useAppState(s => s.authVersion)

  useEffect(() => {
    const isActive = isDeepSeekSubscriber()
    if (!isActive) {
      setLabel(null)
      return
    }

    async function load(): Promise<void> {
      const auth = getDeepSeekAuth()
      if (!auth?.apiKey) {
        setLabel(null)
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
        if (!response.ok) {
          setLabel(null)
          return
        }
        const body = (await response.json()) as BalanceResponse
        if (!body.is_available || !body.balance_infos?.length) {
          setLabel(null)
          return
        }
        setLabel(`DS ${body.balance_infos.map(formatEntry).join(' + ')}`)
      } catch {
        // Network/proxy/timeout: stay silent and retry on the next tick
        // rather than flashing an error in the footer.
        setLabel(null)
      } finally {
        clearTimeout(timeout)
      }
    }

    void load()
    const interval = setInterval(() => void load(), REFRESH_MS)

    return () => {
      clearInterval(interval)
    }
  }, [authVersion])

  if (!label) return null
  return (
    <Text dimColor wrap="truncate">
      {label}
      {separator ? ' · ' : ''}
    </Text>
  )
}
