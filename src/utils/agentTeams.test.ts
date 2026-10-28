import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * These tests run against a throwaway config dir. `enableConfigs()` must be
 * called before any config access, and CLAUDE_CONFIG_DIR must point somewhere
 * temporary before that happens — a write to the real config file hijacks a
 * live session, which is the one thing this repo's rules forbid outright.
 */
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axa-agentteams-'))

const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import(
  './config.js'
)
const {
  agentKey,
  createTeam,
  deleteTeam,
  filterLoadedAgents,
  getTeamForAgent,
  isAgentLoaded,
  setAgentLoaded,
  setTeamLoaded,
  setTeamMembers,
} = await import('./agentTeams.js')
const { getActiveAgentsFromList } = await import(
  '../tools/AgentTool/loadAgentsDir.js'
)

enableConfigs()

type AnyAgent = {
  agentType: string
  source: string
  whenToUse?: string
  getSystemPrompt?: () => string
}

const agent = (agentType: string, source: string): AnyAgent => ({
  agentType,
  source,
  whenToUse: 'x',
  getSystemPrompt: () => '',
})

const resetConfig = (): void => {
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: [],
    disabledAgents: [],
    disabledTeams: [],
    agentUsage: {},
  }))
}

beforeEach(resetConfig)

const visible = (list: AnyAgent[]): string[] =>
  filterLoadedAgents(list as any, getGlobalConfig()).map(a => a.agentType)

test('agentKey qualifies by source, so one name cannot mean five agents', () => {
  expect(agentKey({ agentType: 'reviewer', source: 'userSettings' } as any)).toBe(
    'userSettings:reviewer',
  )
  expect(agentKey({ agentType: 'a:b:c', source: 'plugin' } as any)).toBe(
    'plugin:a:b:c',
  )
})

test('nothing is filtered until a deny entry exists', () => {
  const all = [agent('r', 'userSettings'), agent('Explore', 'built-in')]
  expect(visible(all)).toEqual(['r', 'Explore'])
})

test('unloading a team hides its members but not built-ins', () => {
  const team = createTeam('Web', ['userSettings:r'])
  setTeamLoaded(team.id, false)
  expect(visible([agent('r', 'userSettings'), agent('Explore', 'built-in')])).toEqual(
    ['Explore'],
  )
})

test('an individual unload survives a team reload', () => {
  const team = createTeam('Web', ['userSettings:r', 'userSettings:t'])
  setAgentLoaded('userSettings:r', false)
  setTeamLoaded(team.id, true)
  expect(visible([agent('r', 'userSettings'), agent('t', 'userSettings')])).toEqual(
    ['t'],
  )
})

test('an agent moves rather than joining two teams', () => {
  const first = createTeam('First', ['userSettings:r'])
  const second = createTeam('Second', ['userSettings:t'])
  setTeamMembers(second.id, ['userSettings:r', 'userSettings:t'])
  expect(getTeamForAgent('userSettings:r')?.id).toBe(second.id)
  expect(getTeamForAgent('userSettings:t')?.id).toBe(second.id)
  expect(getTeamForAgent('userSettings:r')?.id).not.toBe(first.id)
})

test('createTeam strips seeded members from their previous team', () => {
  createTeam('First', ['userSettings:r'])
  const second = createTeam('Second', ['userSettings:r'])
  expect(getTeamForAgent('userSettings:r')?.id).toBe(second.id)
})

/**
 * Regression: setTeamMembers used to accept an unknown id. The map then ran
 * only the "strip keys that moved into this team" branch over every other
 * team, so the keys left their real teams and landed nowhere — saving an
 * editor whose team had been deleted would silently ungroup every agent.
 */
test('setTeamMembers refuses an unknown team instead of ungrouping its keys', () => {
  const team = createTeam('Web', ['userSettings:r'])
  expect(() => setTeamMembers('does-not-exist', ['userSettings:t'])).toThrow(
    /Unknown team/,
  )
  expect(getTeamForAgent('userSettings:r')?.id).toBe(team.id)
})

/**
 * Regression: an agent blocked only by its unloaded team cannot be brought back
 * by setAgentLoaded — that clears disabledAgents, while isAgentLoaded still
 * returns false because the team is disabled. The UI must therefore not present
 * that as a successful load.
 */
test('loading an agent individually does not defeat its unloaded team', () => {
  const team = createTeam('Web', ['userSettings:r'])
  setTeamLoaded(team.id, false)
  setAgentLoaded('userSettings:r', true)
  expect(isAgentLoaded('userSettings:r')).toBe(false)
  // The supported path: load the team.
  setTeamLoaded(team.id, true)
  expect(isAgentLoaded('userSettings:r')).toBe(true)
})

test('deleting a team keeps its agents and drops its deny entry', () => {
  const team = createTeam('Web', ['userSettings:r'])
  setTeamLoaded(team.id, false)
  deleteTeam(team.id)
  expect(getGlobalConfig().disabledTeams ?? []).not.toContain(team.id)
  expect(isAgentLoaded('userSettings:r')).toBe(true)
})

/**
 * A duplicated key is only reachable by hand-editing the config, but when it
 * happens the filter and the UI badge must not disagree: both resolve by first
 * match.
 */
test('a duplicated key filters against the first team, matching the badge', () => {
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: [
      { id: 'first', name: 'First', agentKeys: ['userSettings:r'] },
      { id: 'second', name: 'Second', agentKeys: ['userSettings:r'] },
    ],
    disabledTeams: ['first'],
  }))
  expect(getTeamForAgent('userSettings:r')?.id).toBe('first')
  expect(isAgentLoaded('userSettings:r')).toBe(false)
  expect(visible([agent('r', 'userSettings')])).toEqual([])
})

test('an unloaded agent cannot expose the agent it shadows', () => {
  const all = [agent('r', 'userSettings'), agent('r', 'projectSettings')]
  // projectSettings wins this pair in the loader's group order. Unloading the
  // winner must remove the type entirely, not fall through to the userSettings
  // copy: that is a different agent than the one that was in effect.
  setAgentLoaded('projectSettings:r', false)
  expect(
    getActiveAgentsFromList(all as any).map(a => a.agentType),
  ).toEqual([])
})

test('skipLoadFilter resolves precedence without applying unload state', () => {
  setAgentLoaded('projectSettings:r', false)
  const all = [agent('r', 'userSettings'), agent('r', 'projectSettings')]
  const byPrecedence = getActiveAgentsFromList(all as any, {
    skipLoadFilter: true,
  })
  expect(byPrecedence.map(a => a.source)).toEqual(['projectSettings'])
  expect(getActiveAgentsFromList(all as any).map(a => a.agentType)).toEqual([])
})
