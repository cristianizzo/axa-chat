import * as React from 'react'
import type { ReactNode } from 'react'
import { Text } from '../../ink.js'
import {
  PROVIDER_CONNECTED_GLYPH,
  PROVIDER_DISCONNECTED_GLYPH,
  type ProviderStatusLight,
} from '../../utils/logoV2Utils.js'

/**
 * The banner's connected-accounts line: every registered provider with a light
 * saying whether credentials for it are stored, and the active one emphasised.
 *
 * Its printed width is what `formatProviderStatusLine` returns, so callers can
 * size the panel from the string without rendering this first.
 *
 * @param lights - The providers to show, from `getProviderStatusLights()`
 */
export function ProviderStatusLights({
  lights,
}: {
  lights: readonly ProviderStatusLight[]
}): ReactNode {
  return (
    <Text>
      {lights.map((light, index) => (
        // Only the active account is undimmed, so it reads at a glance against
        // the rest of the banner, which is dim throughout. That leaves the
        // glyph as the only thing separating a connected account from an
        // unconfigured one — hence the colour on it as well as the shape, for
        // terminals and themes where green is not distinguishable.
        <Text key={light.id} bold={light.active} dimColor={!light.active}>
          {index > 0 ? ' ' : ''}
          {light.label}{' '}
          <Text color={light.connected ? 'success' : undefined}>
            {light.connected
              ? PROVIDER_CONNECTED_GLYPH
              : PROVIDER_DISCONNECTED_GLYPH}
          </Text>
        </Text>
      ))}
    </Text>
  )
}
