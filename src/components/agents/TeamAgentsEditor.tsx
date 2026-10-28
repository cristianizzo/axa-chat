import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  agentKey,
  getTeamById,
  getTeamForAgent,
  setTeamMembers,
} from '../../utils/agentTeams.js'
import { getSettingSourceName } from '../../utils/settings/constants.js'
import { SelectMulti } from '../CustomSelect/SelectMulti.js'
import type { OptionWithDescription } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'

type Props = {
  teamId: string
  agents: AgentDefinition[]
  onDone: () => void
  onBack: () => void
}

/**
 * Ticks the members of one team. The option value is the canonical
 * `<source>:<agentType>` key, because the same agentType can exist at several
 * sources and only the key names the agent the loader actually resolved.
 *
 * Submitting hands the whole ticked set to setTeamMembers, which also strips
 * those keys from any other team. That is why the hint says ticking a member
 * of another team moves it: an agent is in at most one team.
 */
export function TeamAgentsEditor({
  teamId,
  agents,
  onDone,
  onBack,
}: Props): React.ReactElement {
  const team = getTeamById(teamId)
  const teamName = team?.name ?? teamId

  const options: OptionWithDescription<string>[] = []
  for (const agent of agents) {
    if (agent.source === 'built-in') continue
    const key = agentKey(agent)
    const owner = getTeamForAgent(key)
    const parts: string[] = []
    if (agent.source !== 'plugin') parts.push(getSettingSourceName(agent.source))
    if (owner && owner.id !== teamId) parts.push(`in ${owner.name}`)
    options.push({
      value: key,
      label: agent.agentType,
      description: parts.length > 0 ? parts.join(', ') : undefined,
    })
  }

  const defaultValue = (team?.agentKeys ?? []).filter(key =>
    options.some(option => option.value === key),
  )

  const handleSubmit = (values: string[]): void => {
    setTeamMembers(teamId, values)
    onDone()
  }

  return (
    <Dialog
      title={`Members of ${teamName}`}
      subtitle={`${defaultValue.length} selected`}
      onCancel={onBack}
      hideInputGuide
    >
      <Box flexDirection="column">
        <SelectMulti
          options={options}
          defaultValue={defaultValue}
          submitButtonText="Save changes"
          onSubmit={handleSubmit}
          onCancel={onBack}
        />
        <Box marginTop={1}>
          <Text dimColor>
            Ticking an agent that belongs to another team moves it here. Agents
            are in at most one team; built-in agents are never listed.
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
