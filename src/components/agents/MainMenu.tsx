import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
import { Dialog } from '../design-system/Dialog.js'

export type MainMenuChoice = 'agents' | 'teams' | 'skills'

type Props = {
  /** Non-built-in agents currently offered to the model. */
  agentCount: number
  /** Non-built-in agents on disk, loaded or not. */
  totalAgentCount: number
  teamCount: number
  skillCount: number
  onSelect: (choice: MainMenuChoice) => void
  onBack: () => void
}

/**
 * Entry screen for /agents. The three kinds are separate destinations rather
 * than tabs because they have genuinely different operations: agents and teams
 * are load/unload, skills are not (a skill is either listed for the model or
 * flagged manual-only, and is never a team member).
 */
export function MainMenu({
  agentCount,
  totalAgentCount,
  teamCount,
  skillCount,
  onSelect,
  onBack,
}: Props): React.ReactElement {
  // The loaded/total pair is the point of this screen: an agent that is only
  // on disk costs the model nothing, and this is the one number that shows it.
  const agentHint =
    agentCount === totalAgentCount
      ? `${totalAgentCount} ${plural(totalAgentCount, 'agent')}`
      : `${agentCount} of ${totalAgentCount} agents loaded`

  const items: Array<{ value: MainMenuChoice; label: string; hint: string }> = [
    {
      value: 'agents',
      label: 'Agents',
      hint: agentHint,
    },
    {
      value: 'teams',
      label: 'Teams',
      hint: `${teamCount} ${plural(teamCount, 'team')}`,
    },
    {
      value: 'skills',
      label: 'Skills',
      hint: `${skillCount} ${plural(skillCount, 'skill')}, never grouped into teams`,
    },
  ]

  const [index, setIndex] = React.useState(0)

  const handleKeyDown = (e: { key: string; preventDefault: () => void }): void => {
    if (e.key === 'return') {
      e.preventDefault()
      const item = items[index]
      if (item) onSelect(item.value)
      return
    }
    if (e.key !== 'up' && e.key !== 'down') return
    e.preventDefault()
    const delta = e.key === 'down' ? 1 : -1
    setIndex(prev => (prev + delta + items.length) % items.length)
  }

  return (
    <Dialog title="Agents" subtitle="Manage agents, teams and skills" onCancel={onBack}>
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus
        onKeyDown={handleKeyDown}
      >
        {items.map((item, i) => {
          const focused = i === index
          return (
            <Box key={item.value}>
              <Text color={focused ? 'suggestion' : undefined}>
                {focused ? `${figures.pointer} ` : '  '}
              </Text>
              <Text color={focused ? 'suggestion' : undefined}>{item.label}</Text>
              <Text dimColor>{` · ${item.hint}`}</Text>
            </Box>
          )
        })}
      </Box>
    </Dialog>
  )
}
