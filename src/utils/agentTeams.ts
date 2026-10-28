import { randomUUID } from 'crypto'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { type AgentTeam, type GlobalConfig, getGlobalConfig, saveGlobalConfig } from './config.js'

/**
 * Canonical identity for an agent across the config file, the loader filter and
 * the UI. Qualifying by source is what makes an unload target the agent the
 * loader actually chose: getActiveAgentsFromList resolves agents with the same
 * agentType by settings precedence, so "<source>:<agentType>" names one agent
 * and the bare name names up to five.
 */
export function agentKey(agent: Pick<AgentDefinition, 'source' | 'agentType'>): string {
  return `${agent.source}:${agent.agentType}`
}

/** Parses a key back into its parts. Used for display only; never for lookup. */
export function parseAgentKey(key: string): { source: string; agentType: string } {
  const idx = key.indexOf(':')
  if (idx < 0) return { source: 'unknown', agentType: key }
  return { source: key.slice(0, idx), agentType: key.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function getTeams(): AgentTeam[] {
  return getGlobalConfig().agentTeams ?? []
}

export function getTeamById(id: string): AgentTeam | undefined {
  return getTeams().find(t => t.id === id)
}

/** The team an agent belongs to, if any. An agent is in at most one team. */
export function getTeamForAgent(key: string): AgentTeam | undefined {
  return getTeams().find(t => t.agentKeys.includes(key))
}

/**
 * Creates a team. Ids are slugs so they stay readable in config.json, with a
 * random suffix only when the slug is already taken — renaming a team keeps
 * its id, so references from disabledTeams survive a rename.
 */
export function createTeam(name: string, agentKeys: string[] = []): AgentTeam {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Team name cannot be empty')
  const existing = getTeams()
  const base = slugify(trimmed)
  let id = base
  if (existing.some(t => t.id === id)) {
    id = `${base}-${randomUUID().slice(0, 8)}`
  }
  const team: AgentTeam = { id, name: trimmed, agentKeys: [...new Set(agentKeys)] }
  const seeded = new Set(team.agentKeys)
  saveGlobalConfig(current => ({
    ...current,
    // Seed members are stripped from their previous teams, same as
    // setTeamMembers: an agent is in at most one team, and getTeamForAgent
    // resolves by first match, so a duplicate would silently shadow.
    agentTeams: [
      ...(current.agentTeams ?? []).map(t => ({
        ...t,
        agentKeys: t.agentKeys.filter(k => !seeded.has(k)),
      })),
      team,
    ],
  }))
  return team
}

export function renameTeam(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Team name cannot be empty')
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: (current.agentTeams ?? []).map(t =>
      t.id === id ? { ...t, name: trimmed } : t,
    ),
  }))
}

/**
 * Deletes the team record only. Member agents are untouched and become
 * ungrouped; no files are unlinked. Any disabledTeams entry for the id is
 * dropped with it, because a stale id would otherwise keep filtering nothing
 * visible and look like a phantom.
 */
export function deleteTeam(id: string): void {
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: (current.agentTeams ?? []).filter(t => t.id !== id),
    disabledTeams: (current.disabledTeams ?? []).filter(t => t !== id),
  }))
}

/**
 * Sets the exact membership of a team. An agent belongs to at most one team,
 * so assigning an agent that already sits in another team moves it — that is
 * the model the user asked for, and silently keeping both would make
 * "loading a team loads all of its agents" ambiguous.
 */
export function setTeamMembers(teamId: string, keys: string[]): void {
  // Without this guard a stale id — a team deleted under an open editor — makes
  // the map run only the "strip keys that moved into this team" branch: the
  // keys leave their real teams and land nowhere. Saving the editor would
  // silently ungroup every agent it ticked.
  if (!getTeamById(teamId)) throw new Error(`Unknown team: ${teamId}`)
  const wanted = new Set(keys)
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: (current.agentTeams ?? []).map(t => {
      if (t.id === teamId) return { ...t, agentKeys: [...wanted] }
      // Drop keys that moved into this team.
      return { ...t, agentKeys: t.agentKeys.filter(k => !wanted.has(k)) }
    }),
  }))
}

export function addAgentToTeam(teamId: string, key: string): void {
  const team = getTeamById(teamId)
  if (!team) throw new Error(`Unknown team: ${teamId}`)
  setTeamMembers(teamId, [...team.agentKeys, key])
}

export function removeAgentFromTeam(teamId: string, key: string): void {
  const team = getTeamById(teamId)
  if (!team) throw new Error(`Unknown team: ${teamId}`)
  setTeamMembers(teamId, team.agentKeys.filter(k => k !== key))
}

// ---------------------------------------------------------------------------
// Loaded / unloaded
// ---------------------------------------------------------------------------

export function isTeamLoaded(id: string): boolean {
  return !(getGlobalConfig().disabledTeams ?? []).includes(id)
}

export function isAgentLoaded(key: string): boolean {
  const config = getGlobalConfig()
  if ((config.disabledAgents ?? []).includes(key)) return false
  const team = getTeamForAgent(key)
  return team === undefined || !(config.disabledTeams ?? []).includes(team.id)
}

/**
 * Loading a team clears the team-level deny entry only. It does not resurrect
 * members the user individually unloaded — "load the team" is one decision
 * about the group, and silently overriding a per-agent choice would make that
 * choice unreversible without hunting.
 */
export function setTeamLoaded(id: string, loaded: boolean): void {
  saveGlobalConfig(current => {
    const disabled = new Set(current.disabledTeams ?? [])
    if (loaded) disabled.delete(id)
    else disabled.add(id)
    return { ...current, disabledTeams: [...disabled] }
  })
}

export function setAgentLoaded(key: string, loaded: boolean): void {
  saveGlobalConfig(current => {
    const disabled = new Set(current.disabledAgents ?? [])
    if (loaded) disabled.delete(key)
    else disabled.add(key)
    return { ...current, disabledAgents: [...disabled] }
  })
}

/**
 * The one load/visibility predicate, called from getActiveAgentsFromList.
 * Built-ins are never filtered: Explore, Plan and general-purpose are load
 * bearing and a user cannot reach a state where they are unavailable.
 *
 * Kept pure (config passed in) so it can be exercised without touching the
 * real global config, which would hijack a live session's settings file.
 */
export function filterLoadedAgents(
  agents: AgentDefinition[],
  config: Pick<GlobalConfig, 'disabledAgents' | 'disabledTeams' | 'agentTeams'>,
): AgentDefinition[] {
  const disabledAgents = new Set(config.disabledAgents ?? [])
  const disabledTeams = new Set(config.disabledTeams ?? [])
  if (disabledAgents.size === 0 && disabledTeams.size === 0) return agents

  // First match wins, matching getTeamForAgent. Last-wins here would mean a
  // duplicated key (only reachable via an external config edit) filters one
  // team while the UI badge reports the other, so the two would disagree about
  // the same agent.
  const teamByAgent = new Map<string, string>()
  for (const team of config.agentTeams ?? []) {
    for (const key of team.agentKeys) {
      if (!teamByAgent.has(key)) teamByAgent.set(key, team.id)
    }
  }

  return agents.filter(agent => {
    if (agent.source === 'built-in') return true
    const key = agentKey(agent)
    if (disabledAgents.has(key)) return false
    const teamId = teamByAgent.get(key)
    return teamId === undefined || !disabledTeams.has(teamId)
  })
}

export function loadAllTeams(): void {
  saveGlobalConfig(current => ({ ...current, disabledTeams: [] }))
}

export function unloadAllTeams(): void {
  saveGlobalConfig(current => ({
    ...current,
    disabledTeams: (current.agentTeams ?? []).map(t => t.id),
  }))
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Most recent spawn across a team's members, or undefined if never used. */
export function getTeamLastUsed(team: AgentTeam): number | undefined {
  const usage = getGlobalConfig().agentUsage
  if (!usage) return undefined
  let latest: number | undefined
  for (const key of team.agentKeys) {
    const at = usage[key]?.lastUsedAt
    if (at !== undefined && (latest === undefined || at > latest)) latest = at
  }
  return latest
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'team'
}
