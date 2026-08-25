import picomatch from 'picomatch'
import { getIsInteractive, getOriginalCwd } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { createSystemMessage } from '../../utils/messages.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { getSentinelConfig, type SentinelConfig } from './config.js'
import { getTreeChanges } from './changes.js'
import { attemptRepair } from './repair.js'
import { runVerify } from './verify.js'

/**
 * Repo sentinel: after a turn that changed files, run the project's verify
 * command and report only the failures those changes introduced.
 *
 * Dispatched from stopHooks rather than a filesystem watcher. The trigger that
 * matters is "the tree changed and the agent has stopped touching it", which is
 * exactly a stop hook; a watcher would fire mid-edit, when a half-written file
 * fails to compile for reasons nobody needs telling about.
 *
 * The load-bearing idea is the baseline. A repo that already fails its own
 * typecheck is normal, and a tool that reports those pre-existing errors as if
 * the last turn caused them is worse than no tool: it trains you to ignore it.
 * So the sentinel remembers which failures it has already seen and stays quiet
 * about them, reporting strictly what is new.
 *
 * With `repair` on, a new failure is also handed to an agent working in a
 * throwaway worktree (see repair.ts), which produces a patch to look at. That
 * is a separate opt-in because it costs tokens on every regression, whereas
 * reporting costs one command.
 */

type SentinelState = {
  /**
   * Failures the sentinel will not report: everything it saw the first time it
   * looked, plus everything it has already reported once. Null until that
   * first look.
   *
   * Entries leave as soon as they stop appearing, which is what makes
   * re-introducing the same error later count as new — it would not, if the
   * baseline only ever grew.
   *
   * The first look happens at the end of a turn, not at startup, so a failure
   * that very turn introduced is baselined and never reported. That is the
   * price of not running the verify command during startup, and it is only
   * paid once per session.
   */
  baseline: Set<string> | null
  /** Digest of the last tree judged, so an unchanged tree is not re-verified. */
  lastDigest: string | null
  running: boolean
}

let state: SentinelState = {
  baseline: null,
  lastDigest: null,
  running: false,
}

/** Call once at startup. Cheap: allocates state, touches no disk. */
export function initSentinel(): void {
  state = { baseline: null, lastDigest: null, running: false }
}

/**
 * Entry point from stopHooks. Returns without cost when the feature is off,
 * which is the default — one config read.
 */
export async function executeSentinel(
  context: REPLHookContext,
  appendSystemMessage?: ToolUseContext['appendSystemMessage'],
): Promise<void> {
  const config = getSentinelConfig()
  if (!config) return
  // Reporting has nowhere to go in a headless run, and the verify command can
  // be expensive enough that running it purely for a log line is not worth it.
  if (!getIsInteractive()) return
  if (state.running) return

  const gitRoot = findCanonicalGitRoot(getOriginalCwd())
  if (!gitRoot) return

  const changes = await getTreeChanges(gitRoot)
  if (!changes) return
  if (changes.files.length === 0) return
  if (changes.digest === state.lastDigest) return
  if (!matchesWatch(changes.files, config)) return

  state.running = true
  try {
    const result = await runVerify(config.verify, gitRoot)

    if (result.inconclusive) {
      // Neither reported nor remembered, and specifically not recorded as a
      // judgement on this tree: `lastDigest` stays where it was so the next
      // turn tries again instead of treating the tree as already checked.
      logForDebugging(
        `[sentinel] verify was inconclusive — leaving the baseline alone`,
      )
      return
    }

    state.lastDigest = changes.digest

    if (result.ok) {
      // A green tree is the strongest baseline there is: from here, any
      // failure at all is new.
      state.baseline = new Set()
      return
    }

    const failures = new Set(result.failures)
    if (state.baseline === null) {
      state.baseline = failures
      logForDebugging(
        `[sentinel] baseline established with ${failures.size} pre-existing failure(s)`,
      )
      return
    }

    const introduced = result.failures.filter(f => !state.baseline!.has(f))
    // Prune fixed failures so re-introducing one later still counts as new.
    const surviving = [...state.baseline].filter(f => failures.has(f))
    // Absorb what is about to be reported. Without this the same failure is
    // re-reported on every later turn — and, worse, re-repaired: a fresh agent
    // and a full verify run for a regression the user has already been told
    // about and may be part-way through fixing.
    state.baseline = new Set([...surviving, ...introduced])
    if (introduced.length === 0) return

    logForDebugging(`[sentinel] ${introduced.length} new failure(s)`)
    appendSystemMessage?.(
      createSystemMessage(formatReport(config.verify, introduced), 'warning'),
    )

    if (!config.repair) return
    const patch = await repairInWorktree(
      config,
      gitRoot,
      changes.files,
      introduced,
      context,
    )
    // Reported even though the tree is unchanged: the user has just been told
    // something broke, and silence afterwards reads as "the fix is coming".
    if (patch) appendSystemMessage?.(createSystemMessage(patch, 'info'))
  } catch (e: unknown) {
    logForDebugging(`[sentinel] verify failed to run: ${(e as Error).message}`)
  } finally {
    state.running = false
  }
}

/**
 * Hard ceiling on a repair. The agent is already bounded by turn count, but a
 * turn can block on a five-minute verify run, so turns alone do not bound wall
 * clock. Nothing in the UI can cancel this, which is the real reason the limit
 * exists — an unattended agent needs an end it cannot talk its way out of.
 */
const REPAIR_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Run the repair and render its outcome, or null when there is nothing to say.
 *
 * Failure here is deliberately quiet. The report the user actually asked for
 * has already been delivered; a repair that could not run is a missing bonus,
 * not a second problem to announce.
 */
async function repairInWorktree(
  config: SentinelConfig,
  gitRoot: string,
  dirtyPaths: string[],
  introduced: string[],
  context: REPLHookContext,
): Promise<string | null> {
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), REPAIR_TIMEOUT_MS)
  timer.unref()
  try {
    const outcome = await attemptRepair({
      config,
      gitRoot,
      dirtyPaths,
      introduced,
      context,
      abortController,
    })
    if (outcome.status === 'fixed') {
      return `A fix for the above was worked out in a scratch worktree and verified against \`${config.verify}\`. Your working tree is untouched — apply it if you agree:\n\n\`\`\`diff\n${outcome.diff}\n\`\`\``
    }
    logForDebugging(
      `[sentinel] repair produced no patch: ${outcome.status === 'unavailable' ? outcome.reason : 'no verified fix'}`,
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Empty `watch` means every change counts, which is the common configuration. */
function matchesWatch(files: string[], config: SentinelConfig): boolean {
  if (config.watch.length === 0) return true
  const isMatch = picomatch(config.watch)
  return files.some(file => isMatch(file))
}

/** Cap the report — past a handful, the list stops being readable. */
const MAX_REPORTED = 10

function formatReport(command: string, introduced: string[]): string {
  const shown = introduced.slice(0, MAX_REPORTED)
  const rest = introduced.length - shown.length
  const lines = [
    `\`${command}\` reports ${introduced.length} new failure${introduced.length === 1 ? '' : 's'} since the last check:`,
    ...shown.map(f => `  ${f}`),
  ]
  if (rest > 0) lines.push(`  … and ${rest} more`)
  return lines.join('\n')
}

export function resetSentinelForTesting(): void {
  initSentinel()
}
