import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { DEEPSEEK_BASE_URL } from '../../config/deepseek.js'
import { Text } from '../../ink.js'
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
 * The fetch runs only while `isDeepSeekSubscriber()` is true — i.e. DeepSeek is
 * the active provider AND a key is stored. Switching away stops both the fetch
 * and the poll.
 */
const REFRESH_MS = 60_000

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

export function DeepSeekBalance(): React.ReactNode {
  const [label, setLabel] = useState<string | null>(null)
  // Kept so the effect can tell a *new* provider switch from a re-render; the
  // config read in isDeepSeekSubscriber() is not itself reactive.
  const activeRef = useRef(isDeepSeekSubscriber())

  useEffect(() => {
    const isActive = isDeepSeekSubscriber()
    if (!isActive) {
      activeRef.current = false
      setLabel(null)
      return
    }
    const switchedNow = !activeRef.current
    activeRef.current = true

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const load = async (): Promise<void> => {
      const auth = getDeepSeekAuth()
      if (!auth?.apiKey) {
        setLabel(null)
        return
      }
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
        // Network/proxy failure: stay silent and retry on the next tick rather
        // than flashing an error in the footer.
        setLabel(null)
      }
    }

    void load()
    // Refresh immediately on an active-provider transition, then settle into a
    // timer so the number tracks spend without a request per keystroke.
    if (switchedNow) {
      void load()
    }
    const interval = setInterval(() => void load(), REFRESH_MS)

    return () => {
      clearTimeout(timeout)
      clearInterval(interval)
      controller.abort()
    }
  }, [])

  if (!label) return null
  return (
    <Text dimColor wrap="truncate">
      {label}
    </Text>
  )
}
