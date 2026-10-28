import * as React from 'react'
import { useCallback, useState } from 'react'
import type { Command, CommandResultDisplay } from '../../commands.js'
import {
  type AgentDefinition,
  getActiveAgentsFromList,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../Tool.js'
import { createTeam, getTeams } from '../../utils/agentTeams.js'
import { AgentNavigationFooter } from './AgentNavigationFooter.js'
import { AgentsMenu } from './AgentsMenu.js'
import { MainMenu } from './MainMenu.js'
import { isSkillCommand, SkillsManager } from './SkillsManager.js'
import { TeamAgentsEditor } from './TeamAgentsEditor.js'
import { TeamMenu } from './TeamMenu.js'
import { TeamsList } from './TeamsList.js'

export type ManagerMode =
  | { mode: 'main' }
  | { mode: 'agents' }
  | { mode: 'teams' }
  | { mode: 'team'; teamId: string }
  | { mode: 'team-agents'; teamId: string }
  | { mode: 'skills' }

type Props = {
  tools: Tools
  commands: Command[]
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
}

/**
 * The /agents surface. It owns navigation only: agent CRUD stays in
 * AgentsMenu, while teams and skills get their own screens because their
 * operations genuinely differ (load/unload vs. list/delete), not for layout
 * taste. Keeping one owner per screen is also what stops the three lists
 * drifting apart.
 */
export function AgentManager({ tools, commands, onExit }: Props): React.ReactElement {
  const [mode, setMode] = useState<ManagerMode>({ mode: 'main' })
  const [changes, setChanges] = useState<string[]>([])
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const setAppState = useSetAppState()

  /**
   * Re-derive activeAgents after a membership or load-state change.
   * getActiveAgentsFromList reads config on every call, so only the memoized
   * initial load needs its cache cleared, and clearAgentDefinitionsCache also
   * drops the plugin agent cache, which a reload here should not.
   */
  const refreshAgents = useCallback((): void => {
    setAppState(state => ({
      ...state,
      agentDefinitions: {
        ...state.agentDefinitions,
        activeAgents: getActiveAgentsFromList(state.agentDefinitions.allAgents),
      },
    }))
  }, [setAppState])

  const note = useCallback((message: string): void => {
    setChanges(prev => [...prev, message])
  }, [])

  const activeAgents: AgentDefinition[] = agentDefinitions.activeAgents
  const allAgents: AgentDefinition[] = agentDefinitions.allAgents
  const teams = getTeams()

  switch (mode.mode) {
    case 'main':
      return (
        <MainMenu
          agentCount={activeAgents.filter(a => a.source !== 'built-in').length}
          totalAgentCount={allAgents.filter(a => a.source !== 'built-in').length}
          teamCount={teams.length}
          // Count what SkillsManager actually lists. `type === 'prompt'` also
          // matches built-in prompt commands (statusline, insights) which have
          // no loadedFrom and never appear on that screen.
          skillCount={commands.filter(isSkillCommand).length}
          onSelect={choice => {
            if (choice === 'agents') setMode({ mode: 'agents' })
            else if (choice === 'teams') setMode({ mode: 'teams' })
            else setMode({ mode: 'skills' })
          }}
          onBack={() => onExit('Agents dialog dismissed', { display: 'system' })}
        />
      )

    case 'agents':
      return <AgentsMenu tools={tools} onExit={() => setMode({ mode: 'main' })} />

    case 'teams':
      return (
        <>
          <TeamsList
            agents={allAgents}
            onBack={() => setMode({ mode: 'main' })}
            onSelectTeam={teamId => setMode({ mode: 'team', teamId })}
            onCreateTeam={name => {
              try {
                const team = createTeam(name)
                note(`Created team: ${team.name}`)
                refreshAgents()
                setMode({ mode: 'team-agents', teamId: team.id })
              } catch (error) {
                note(
                  `Could not create team: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                )
              }
            }}
            changes={changes}
          />
          <AgentNavigationFooter />
        </>
      )

    case 'team':
      return (
        <>
          <TeamMenu
            teamId={mode.teamId}
            agents={allAgents}
            onBack={() => setMode({ mode: 'teams' })}
            onEditMembers={() => setMode({ mode: 'team-agents', teamId: mode.teamId })}
            onDeleted={() => {
              note('Team deleted. Member agents were kept and are now ungrouped.')
              refreshAgents()
              setMode({ mode: 'teams' })
            }}
            onLoadedChange={refreshAgents}
            changes={changes}
          />
          <AgentNavigationFooter />
        </>
      )

    case 'team-agents':
      return (
        <>
          <TeamAgentsEditor
            teamId={mode.teamId}
            agents={allAgents}
            onDone={() => {
              refreshAgents()
              setMode({ mode: 'team', teamId: mode.teamId })
            }}
            onBack={() => setMode({ mode: 'team', teamId: mode.teamId })}
          />
          <AgentNavigationFooter />
        </>
      )

    case 'skills':
      return (
        <>
          <SkillsManager
            commands={commands}
            onBack={() => setMode({ mode: 'main' })}
            changes={changes}
          />
          <AgentNavigationFooter />
        </>
      )
  }
}
