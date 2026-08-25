import { getCurrentProjectConfig } from '../../utils/config.js'

/**
 * Resolved sentinel settings. Distinct from the raw `ProjectConfig['sentinel']`
 * shape, which is all-optional because it is user-authored JSON: everything a
 * caller needs is non-optional here, so the validation happens once.
 */
export type SentinelConfig = {
  verify: string
  /**
   * Empty means any change git reports — modified, staged or untracked —
   * which is the common case.
   */
  watch: string[]
  /** Whether to attempt a fix in a throwaway worktree. Off unless asked for. */
  repair: boolean
}

/**
 * Read the sentinel config for the current project, or null when it is off.
 *
 * A missing or malformed field reads as off rather than falling back to a
 * default. The one thing this feature must never do is run a command the user
 * did not write, so `verify` has no default at all — no config, no sentinel.
 */
export function getSentinelConfig(): SentinelConfig | null {
  const raw = getCurrentProjectConfig().sentinel
  if (!raw?.enabled) return null

  const verify = typeof raw.verify === 'string' ? raw.verify.trim() : ''
  if (!verify) return null

  // Trimmed, because a stray leading space in hand-edited JSON produces a glob
  // that matches nothing — and the symptom is the sentinel silently never
  // firing, which is indistinguishable from it being off.
  const watch = Array.isArray(raw.watch)
    ? raw.watch
        .filter((p): p is string => typeof p === 'string')
        .map(p => p.trim())
        .filter(Boolean)
    : []

  return { verify, watch, repair: raw.repair === true }
}
