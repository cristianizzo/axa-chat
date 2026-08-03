import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import {
  ANTHROPIC_PROVIDER_ID,
  AUTH_PROVIDERS,
  type AuthProviderId,
} from '../../config/authProviders.js'
import { CODEX_PROVIDER_ID } from '../../config/codex.js'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../../bootstrap/state.js'
import {
  getActiveAuthProvider,
  hasCredentialsForAuthProvider,
  setActiveAuthProvider,
} from '../../utils/activeAuthProvider.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  getDefaultMainLoopModelSetting,
  isServableByActiveProvider,
  renderModelSetting,
} from '../../utils/model/model.js'
import { clearAuthRelatedCaches } from '../logout/logout.js'

/** Short names accepted as an argument, so `/switch-account codex` works. */
const PROVIDER_ALIASES: Record<string, AuthProviderId> = {
  anthropic: ANTHROPIC_PROVIDER_ID,
  claude: ANTHROPIC_PROVIDER_ID,
  codex: CODEX_PROVIDER_ID,
  openai: CODEX_PROVIDER_ID,
}

/**
 * The account label for a provider, including the email when we know it.
 *
 * Only Anthropic logins store an email; the Codex flow gives us an opaque
 * account ID, so its entry is identified by provider alone.
 */
function describeAccount(id: AuthProviderId): string {
  const info = AUTH_PROVIDERS.find(provider => provider.id === id)
  const label = info?.label ?? id
  if (id !== ANTHROPIC_PROVIDER_ID) {
    return label
  }
  const email = getGlobalConfig().oauthAccount?.emailAddress
  return email ? `${label} (${email})` : label
}

/**
 * Makes the given account active for subsequent turns.
 *
 * Clears a session `/model` choice that the new account cannot serve: it was
 * picked for the previous provider, and keeping it would fail every turn with
 * "model is not supported". Dropping it lets the new provider's default apply,
 * which is the whole point of switching.
 *
 * @param id - The provider to switch to
 * @returns The message to show the user
 */
async function switchTo(id: AuthProviderId): Promise<string> {
  setActiveAuthProvider(id)
  await clearAuthRelatedCaches()

  const override = getMainLoopModelOverride()
  if (override && !isServableByActiveProvider(override)) {
    setMainLoopModelOverride(undefined)
  }

  const model = renderModelSetting(getDefaultMainLoopModelSetting())
  return `Switched to ${describeAccount(id)} · model: ${model}`
}

function SwitchAccount({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  const active = getActiveAuthProvider()
  const available = AUTH_PROVIDERS.filter(provider =>
    hasCredentialsForAuthProvider(provider.id),
  )

  const options = available.map(provider => ({
    label: (
      <Text>
        {describeAccount(provider.id)}
        {provider.id === active ? ' (current)' : ''} ·{' '}
        <Text dimColor={true}>{provider.description}</Text>
      </Text>
    ),
    value: provider.id,
  }))

  return (
    <Box flexDirection="column">
      <Text>Select account:</Text>
      <Select
        options={options}
        defaultValue={active}
        onChange={value => {
          void (async () => {
            const message = await switchTo(value as AuthProviderId)
            context.onChangeAPIKey()
            context.setAppState(prev => ({
              ...prev,
              authVersion: prev.authVersion + 1,
            }))
            onDone(message)
          })()
        }}
      />
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const requested = PROVIDER_ALIASES[args?.trim().toLowerCase() ?? '']
  if (requested) {
    if (!hasCredentialsForAuthProvider(requested)) {
      onDone(
        `Not signed in to ${describeAccount(requested)}. Run /login and pick it first.`,
      )
      return null
    }
    onDone(await switchTo(requested))
    context.onChangeAPIKey()
    return null
  }

  const signedIn = AUTH_PROVIDERS.filter(provider =>
    hasCredentialsForAuthProvider(provider.id),
  )
  if (signedIn.length < 2) {
    onDone(
      'Only one account is signed in. Run /login to add another, then /switch-account to move between them.',
    )
    return null
  }

  return <SwitchAccount onDone={onDone} context={context} />
}
