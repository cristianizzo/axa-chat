import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import {
  ALL_PROVIDERS,
  type AuthProviderId,
  getProvider,
  resolveProviderAlias,
} from '../../config/providers/index.js'
import { Box, Text } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getActiveAuthProvider,
  hasCredentialsForAuthProvider,
  setActiveAuthProvider,
  setStoredModelForProvider,
} from '../../utils/activeAuthProvider.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  getDefaultMainLoopModelSetting,
  renderModelSetting,
  resolveModelForActiveProvider,
} from '../../utils/model/model.js'
import { clearAuthRelatedCaches } from '../logout/logout.js'

/**
 * The account label for a provider, with an identifying detail when we have one.
 *
 * Which detail is the provider's own business — an Anthropic login stores an
 * email, Ollama records the single model it serves — so the descriptor answers
 * it and a provider that has nothing to add simply says so by omission.
 */
function describeAccount(id: AuthProviderId): string {
  const provider = getProvider(id)
  const detail = provider.accountDetail?.(getGlobalConfig())
  return detail ? `${provider.label} (${detail})` : provider.label
}

/**
 * Makes the given account active for subsequent turns, and points the REPL's
 * live model at whatever the new account should use.
 *
 * The model lives in AppState.mainLoopModel, which the request path reads
 * directly. It was seeded for whichever account was active at startup and does
 * not follow an account switch on its own, so without this the previous
 * account's model leaks to the new provider and every turn fails against a
 * backend that cannot serve it (e.g. `claude-opus-4-8` sent to the Ollama
 * daemon → 404). We therefore:
 *
 *  1. Remember the outgoing account's current model, so returning to it later
 *     restores that exact choice rather than falling back to a default. (The
 *     startup-seeded model never passed through onChangeAppState, so the
 *     per-account store would otherwise not know it.)
 *  2. Adopt the incoming account's remembered model if it can serve it, else
 *     null — meaning "use this provider's default". Assigning it through
 *     setAppState fires onChangeAppState, which persists it and updates the
 *     model override, keeping every resolution path in agreement.
 *
 * @param id - The provider to switch to
 * @param context - The command context, for reading and updating AppState
 * @returns The message to show the user
 */
async function switchTo(
  id: AuthProviderId,
  context: LocalJSXCommandContext,
): Promise<string> {
  const outgoing = getActiveAuthProvider()
  const outgoingModel = context.getAppState().mainLoopModel
  if (typeof outgoingModel === 'string') {
    setStoredModelForProvider(outgoing, outgoingModel)
  }

  setActiveAuthProvider(id)
  await clearAuthRelatedCaches()

  const target = resolveModelForActiveProvider()
  context.setAppState(prev => ({
    ...prev,
    mainLoopModel: target,
    mainLoopModelForSession: null,
    authVersion: prev.authVersion + 1,
  }))
  // onChangeAppState only reacts when the value changes; set the override
  // directly so it stays correct even when the target equals the old model.
  setMainLoopModelOverride(target)

  const model = renderModelSetting(target ?? getDefaultMainLoopModelSetting())
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
  const available = ALL_PROVIDERS.filter(provider =>
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
            const message = await switchTo(value as AuthProviderId, context)
            context.onChangeAPIKey()
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
  const requested = resolveProviderAlias(args ?? '')
  if (requested) {
    if (!hasCredentialsForAuthProvider(requested)) {
      onDone(
        `Not signed in to ${describeAccount(requested)}. Run /login and pick it first.`,
      )
      return null
    }
    onDone(await switchTo(requested, context))
    context.onChangeAPIKey()
    return null
  }

  const signedIn = ALL_PROVIDERS.filter(provider =>
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
