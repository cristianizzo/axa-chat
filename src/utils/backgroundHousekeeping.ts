import { feature } from 'bun:bundle'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('../services/extractMemories/extractMemories.js') as typeof import('../services/extractMemories/extractMemories.js'))
  : null
const registerProtocolModule = feature('LODESTONE')
  ? (require('./deepLink/registerProtocol.js') as typeof import('./deepLink/registerProtocol.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupNpmCacheForAnthropicPackages,
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'
import { maybeUpdateSourceInBackground } from './sourceUpdate.js'

// 24 hours in milliseconds
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// 10 minutes after start.
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

// How often to give the source check another chance. Not how often it runs:
// the check throttles itself to once a day and returns immediately in
// between. This only exists because `runVerySlowOps` is a one-shot timer, so
// a REPL left open for a week would otherwise check on day one and never again.
const SOURCE_UPDATE_RECHECK_INTERVAL_MS = 60 * 60 * 1000

let sourceUpdateInterval: NodeJS.Timeout | undefined

function scheduleRecurringSourceUpdateCheck(): void {
  if (sourceUpdateInterval) return
  sourceUpdateInterval = setInterval(() => {
    // Same courtesy as runVerySlowOps: a check can start a multi-minute build,
    // so never off the back of something the user just did.
    if (getLastInteractionTime() > Date.now() - 1000 * 60) return
    void maybeUpdateSourceInBackground()
  }, SOURCE_UPDATE_RECHECK_INTERVAL_MS)
  sourceUpdateInterval.unref()
}

export function startBackgroundHousekeeping(): void {
  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()
  }
  initAutoDream()
  void autoUpdateMarketplacesAndPluginsInBackground()
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }

  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    await cleanupOldVersions()

    // Last, and deliberately inside runVerySlowOps: staging a new build runs
    // `bun install` and a full compile, so it rides the same "wait until the
    // user is idle" gate as the other expensive operations.
    //
    // Interactive only. The idle gate above is itself interactive-only, so a
    // headless run (SDK, CI, a long `-p` session) would start a multi-minute
    // build with no progress bar and no notification, then kill it on exit.
    if (getIsInteractive()) {
      await maybeUpdateSourceInBackground()
      scheduleRecurringSourceUpdateCheck()
    }
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // For long-running sessions, schedule recurring cleanup every 24 hours.
  // Both cleanup functions use marker files and locks to throttle to once per day
  // and skip immediately if another process holds the lock.
  if (process.env.USER_TYPE === 'ant') {
    const interval = setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, RECURRING_CLEANUP_INTERVAL_MS)

    // Don't let this interval keep the process alive
    interval.unref()
  }
}
