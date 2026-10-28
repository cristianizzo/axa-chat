import figures from 'figures'
import * as React from 'react'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  agentKey,
  getTeamLastUsed,
  getTeams,
  isTeamLoaded,
} from '../../utils/agentTeams.js'
import type { AgentTeam } from '../../utils/config.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import {
  Select,
  type OptionWithDescription,
} from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  agents: AgentDefinition[]
  onBack: () => void
  onSelectTeam: (teamId: string) => void
  onCreateTeam: (name: string) => void
  changes?: string[]
}

type Row =
  | { kind: 'team'; team: AgentTeam }
  | { kind: 'create' }
  | { kind: 'back' }

/**
 * One row per team, then `Create new team` and `Back`. Keyboard navigation
 * mirrors AgentsList: a single focused index over the flattened row list,
 * wrapping at both ends, Enter activates the focused row.
 *
 * `Create new team` swaps the list for a one-field name prompt; the typed name
 * is handed to `onCreateTeam`, which owns the actual `createTeam` call and the
 * navigation that follows it.
 */
export function TeamsList({
  agents,
  onBack,
  onSelectTeam,
  onCreateTeam,
  changes,
}: Props): React.ReactElement {
  const [mode, setMode] = React.useState<'list' | 'create'>('list')
  const [newName, setNewName] = React.useState('')
  const [error, setError] = React.useState<string | undefined>(undefined)

  const teams = getTeams()

  // A key identifies an agent across sources; the member count is the number
  // of the team's members that still resolve to a real agent, so a stale key
  // left behind by a deleted file does not inflate the count.
  const availableKeys = new Set(agents.map(agentKey))

  const rows: Row[] = [
    ...teams.map<Row>(team => ({ kind: 'team', team })),
    { kind: 'create' },
    { kind: 'back' },
  ]

  const [focusedIndex, setFocusedIndex] = React.useState(0)
  const activeIndex = Math.min(focusedIndex, rows.length - 1)

  const activate = (row: Row | undefined): void => {
    if (!row) return
    if (row.kind === 'team') onSelectTeam(row.team.id)
    else if (row.kind === 'create') {
      setNewName('')
      setError(undefined)
      setMode('create')
    } else onBack()
  }

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'return') {
      e.preventDefault()
      activate(rows[activeIndex])
      return
    }
    if (e.key !== 'up' && e.key !== 'down') return
    e.preventDefault()
    if (rows.length === 0) return
    const delta = e.key === 'down' ? 1 : -1
    setFocusedIndex((activeIndex + delta + rows.length) % rows.length)
  }

  if (mode === 'create') {
    const options: OptionWithDescription<'name'>[] = [
      {
        type: 'input',
        label: 'Team name',
        value: 'name',
        placeholder: 'team name',
        initialValue: '',
        onChange: setNewName,
        // Send an empty submission to `submit` so it can show the error
        // rather than letting Select treat empty as a cancel.
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      },
    ]

    const submit = (): void => {
      if (!newName.trim()) {
        // createTeam would throw the same message; checking here keeps the
        // input open instead of bouncing through the parent to get an error.
        setError('Team name cannot be empty')
        return
      }
      onCreateTeam(newName)
    }

    return (
      <Dialog
        title="Teams"
        subtitle="Create new team"
        onCancel={() => setMode('list')}
      >
        <Select
          options={options}
          onChange={submit}
          onCancel={() => setMode('list')}
        />
        {error && (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        )}
        {/* A rejected name comes back from the parent as a `changes` note,
            because createTeam lives there; show it without leaving the input. */}
        {!error && changes && changes.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{changes[changes.length - 1]}</Text>
          </Box>
        )}
      </Dialog>
    )
  }

  const renderRow = (row: Row, i: number): React.ReactElement => {
    const focused = i === activeIndex
    const pointer = focused ? `${figures.pointer} ` : '  '
    const color = focused ? 'suggestion' : undefined

    if (row.kind !== 'team') {
      return (
        <Box key={row.kind}>
          <Text color={color}>{pointer}</Text>
          <Text color={color}>
            {row.kind === 'create' ? 'Create new team' : 'Back'}
          </Text>
        </Box>
      )
    }

    const { team } = row
    const memberCount = team.agentKeys.filter(key =>
      availableKeys.has(key),
    ).length
    const lastUsed = getTeamLastUsed(team)
    const loaded = isTeamLoaded(team.id)

    return (
      <Box key={team.id} flexDirection="column">
        <Box>
          <Text color={color}>{pointer}</Text>
          <Text color={color}>{team.name}</Text>
          <Text dimColor>
            {` · ${memberCount} ${plural(memberCount, 'agent')}`}
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>
            {lastUsed === undefined
              ? 'never used'
              : `last used ${formatRelativeTimeAgo(new Date(lastUsed))}`}
          </Text>
          <Text dimColor> · </Text>
          {loaded ? (
            <Text color="success">● loaded</Text>
          ) : (
            <Text dimColor>○ unloaded</Text>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Dialog
      title="Teams"
      subtitle={`${teams.length} ${plural(teams.length, 'team')}`}
      onCancel={onBack}
      hideInputGuide
    >
      <Box
        flexDirection="column"
        gap={1}
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
      >
        {rows.map(renderRow)}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      {changes && changes.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{changes[changes.length - 1]}</Text>
        </Box>
      )}
    </Dialog>
  )
}
