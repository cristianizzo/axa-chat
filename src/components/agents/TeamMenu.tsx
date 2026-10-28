import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  agentKey,
  deleteTeam,
  getTeamById,
  isTeamLoaded,
  renameTeam,
  setTeamLoaded,
} from '../../utils/agentTeams.js'
import { plural } from '../../utils/stringUtils.js'
import {
  Select,
  type OptionWithDescription,
} from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  teamId: string
  agents: AgentDefinition[]
  onBack: () => void
  onEditMembers: () => void
  onDeleted: () => void
  /** Called after any config mutation so the parent can re-derive activeAgents. */
  onLoadedChange: () => void
  changes?: string[]
}

type Step = 'menu' | 'rename' | 'delete-confirm'

type MenuChoice = 'members' | 'rename' | 'load' | 'delete' | 'back'

/**
 * Actions for a single team. Two of them are two-step on purpose: renaming
 * submits from an input option, and deleting asks first and spells out that
 * the member agents survive as ungrouped.
 *
 * Config mutations do not re-render on their own, so a local counter is bumped
 * alongside `onLoadedChange()` to redraw the menu's Load/Unload label.
 */
export function TeamMenu({
  teamId,
  agents,
  onBack,
  onEditMembers,
  onDeleted,
  onLoadedChange,
  changes,
}: Props): React.ReactElement {
  const [step, setStep] = React.useState<Step>('menu')
  const [renameValue, setRenameValue] = React.useState('')
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0)

  const team = getTeamById(teamId)
  const teamName = team?.name ?? teamId
  const loaded = isTeamLoaded(teamId)
  const availableKeys = new Set(agents.map(agentKey))
  const memberCount = (team?.agentKeys ?? []).filter(key =>
    availableKeys.has(key),
  ).length

  if (!team) {
    return (
      <Dialog title={teamName} onCancel={onBack} color="error">
        <Text>This team no longer exists.</Text>
        <Box marginTop={1}>
          <Select
            options={[{ label: 'Back', value: 'back' }]}
            onChange={onBack}
            onCancel={onBack}
          />
        </Box>
      </Dialog>
    )
  }

  const handleMenuChange = (value: MenuChoice): void => {
    setError(undefined)
    switch (value) {
      case 'members':
        onEditMembers()
        return
      case 'rename':
        setRenameValue(teamName)
        setStep('rename')
        return
      case 'load':
        setTeamLoaded(teamId, !loaded)
        onLoadedChange()
        forceRender()
        return
      case 'delete':
        setStep('delete-confirm')
        return
      case 'back':
        onBack()
        return
    }
  }

  if (step === 'rename') {
    const renameOptions: OptionWithDescription<'rename'>[] = [
      {
        type: 'input',
        label: 'Team name',
        value: 'rename',
        placeholder: 'team name',
        initialValue: teamName,
        onChange: setRenameValue,
        // Let an empty submission reach submitRename so the "cannot be empty"
        // error is shown, instead of Select treating empty as cancel.
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      },
    ]

    const submitRename = (): void => {
      try {
        renameTeam(teamId, renameValue)
        setStep('menu')
        setError(undefined)
        onLoadedChange()
        forceRender()
      } catch (e) {
        // renameTeam throws on an empty name; surface it instead of crashing.
        setError(e instanceof Error ? e.message : String(e))
      }
    }

    return (
      <Dialog title={teamName} subtitle="Rename team" onCancel={onBack}>
        <Select
          options={renameOptions}
          onChange={submitRename}
          onCancel={() => {
            setStep('menu')
            setError(undefined)
          }}
        />
        {error && (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        )}
      </Dialog>
    )
  }

  if (step === 'delete-confirm') {
    const confirmOptions: OptionWithDescription<'yes' | 'no'>[] = [
      { label: 'Yes, delete team', value: 'yes' },
      { label: 'No, cancel', value: 'no' },
    ]

    const handleConfirm = (value: 'yes' | 'no'): void => {
      if (value === 'yes') {
        deleteTeam(teamId)
        onLoadedChange()
        onDeleted()
      } else {
        setStep('menu')
      }
    }

    return (
      <Dialog
        title="Delete team"
        onCancel={() => setStep('menu')}
        color="error"
      >
        <Text>
          Delete the team <Text bold>{teamName}</Text>?
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            The team record is removed. Its member agents are not deleted, they
            just become ungrouped.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Select
            options={confirmOptions}
            onChange={handleConfirm}
            onCancel={() => setStep('menu')}
          />
        </Box>
      </Dialog>
    )
  }

  const menuOptions: OptionWithDescription<MenuChoice>[] = [
    { label: 'View members', value: 'members' },
    { label: 'Rename team', value: 'rename' },
    {
      label: loaded ? 'Unload team' : 'Load team',
      value: 'load',
      description: loaded
        ? 'Members stop being offered to the model. Nothing is deleted.'
        : 'All members become available again.',
    },
    { label: 'Delete team', value: 'delete' },
    { label: 'Back', value: 'back' },
  ]

  const changeLine =
    error ??
    (changes && changes.length > 0 ? changes[changes.length - 1] : undefined)

  return (
    <Dialog
      title={teamName}
      subtitle={`${memberCount} ${plural(memberCount, 'agent')}, ${
        loaded ? 'loaded' : 'unloaded'
      }`}
      onCancel={onBack}
      hideInputGuide
    >
      <Box flexDirection="column">
        <Select
          options={menuOptions}
          onChange={handleMenuChange}
          onCancel={onBack}
        />
        {changeLine && (
          <Box marginTop={1}>
            <Text dimColor>{changeLine}</Text>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}
