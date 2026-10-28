import { saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'

const AGENT_USAGE_DEBOUNCE_MS = 60_000

// Process-lifetime debounce cache — avoids lock + read + parse on debounced
// calls. Same pattern as lastWriteBySkill in skillUsageTracking.ts.
const lastWriteByAgent = new Map<string, number>()

/**
 * Records that an agent was spawned, for the "last used" column in /agents.
 *
 * `agentKey` must be the "<source>:<agentType>" form built by agentKey() in
 * utils/agentTeams.ts. The UI joins on that canonical form, so a bare agent
 * name would write a counter nothing ever reads.
 *
 * Never throws: this is called from the Agent tool's hot path, and failing to
 * write a usage counter must not fail the spawn.
 */
export function recordAgentUsage(agentKey: string): void {
  const now = Date.now()
  const lastWrite = lastWriteByAgent.get(agentKey)
  if (lastWrite !== undefined && now - lastWrite < AGENT_USAGE_DEBOUNCE_MS) {
    return
  }
  lastWriteByAgent.set(agentKey, now)
  try {
    saveGlobalConfig(current => {
      const existing = current.agentUsage?.[agentKey]
      return {
        ...current,
        agentUsage: {
          ...current.agentUsage,
          [agentKey]: {
            usageCount: (existing?.usageCount ?? 0) + 1,
            lastUsedAt: now,
          },
        },
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`Failed to record agent usage for ${agentKey}: ${message}`)
  }
}
