import * as React from 'react'
import { getProvider } from 'src/config/providers/index.js'
import { useAppState } from 'src/state/AppState.js'
import {
  getActiveAuthProvider,
  hasCredentialsForAuthProvider,
} from '../../utils/activeAuthProvider.js'
import {
  PROVIDER_CONNECTED_GLYPH,
  PROVIDER_DISCONNECTED_GLYPH,
} from '../../utils/logoV2Utils.js'
import { Text } from '../../ink.js'

/**
 * The account currently serving the session, e.g. `DeepSeek ●`.
 *
 * A compact sibling of the banner's connected-accounts line, for the footer's
 * right bar: the provider label plus the same connected/disconnected glyph. It
 * shows only the *active* provider — the one whose credentials are answering
 * requests — so it doubles as the answer to "which account am I on right now?"
 * without the full line's width cost.
 *
 * Re-renders on account switch: `/switch-account` bumps `authVersion` in
 * AppState, which this component subscribes to. The label/glyph are read fresh
 * from config at that point, so the pill follows the active account.
 */
export function ProviderStatus(): React.ReactNode {
  useAppState(s => s.authVersion)
  const id = getActiveAuthProvider()
  const provider = getProvider(id)
  const label = provider.shortLabel ?? provider.label
  const glyph = hasCredentialsForAuthProvider(id)
    ? PROVIDER_CONNECTED_GLYPH
    : PROVIDER_DISCONNECTED_GLYPH
  return (
    <Text dimColor wrap="truncate">
      {label} {glyph}
    </Text>
  )
}
