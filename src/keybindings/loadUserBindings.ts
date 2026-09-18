/**
 * User keybinding configuration loader with hot-reload support.
 *
 * Loads keybindings from ~/.claude/keybindings.json and watches
 * for changes to reload them automatically.
 *
 * User keybinding customization is enabled by default. It can still be turned
 * off remotely through the tengu_keybinding_customization_release gate; see
 * isKeybindingCustomizationEnabled().
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { readFileSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  onGrowthBookRefresh,
} from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { createSignal } from '../utils/signal.js'
import { jsonParse } from '../utils/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import {
  checkDuplicateKeysInJson,
  type KeybindingWarning,
  validateBindings,
} from './validate.js'

const KEYBINDING_GATE = 'tengu_keybinding_customization_release'

/**
 * Check if keybinding customization is enabled.
 *
 * Enabled unless tengu_keybinding_customization_release explicitly says
 * otherwise, so the gate keeps working as a remote kill switch.
 *
 * The cached value has to be read directly: getFeatureValue_CACHED_MAY_BE_STALE
 * returns its default before ever consulting cachedGrowthBookFeatures when 1P
 * event logging is off (growthbook.ts), which is precisely the state where the
 * absent gate used to resolve to `false`. loadKeybindings() then returned early
 * and ~/.claude/keybindings.json was never read at all — a user binding did
 * nothing, with no warning to tell it apart from a malformed config file.
 *
 * This function is exported so other parts of the codebase (e.g., /doctor)
 * can check the same condition consistently.
 */
export function isKeybindingCustomizationEnabled(): boolean {
  const gate = getFeatureValue_CACHED_MAY_BE_STALE<boolean | undefined>(
    KEYBINDING_GATE,
    undefined,
  )
  if (typeof gate === 'boolean') return gate

  try {
    const cached = getGlobalConfig().cachedGrowthBookFeatures?.[KEYBINDING_GATE]
    if (typeof cached === 'boolean') return cached
  } catch {
    // getGlobalConfig() throws before config reading is allowed; treat the
    // gate as absent, same as the disk-cache fallback inside GrowthBook.
  }

  return true
}

/**
 * Time in milliseconds to wait for file writes to stabilize.
 */
const FILE_STABILITY_THRESHOLD_MS = 500

/**
 * Polling interval for checking file stability.
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 200

/**
 * Result of loading keybindings, including any validation warnings.
 */
export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]
  warnings: KeybindingWarning[]
}

let watcher: FSWatcher | null = null
let initialized = false
let disposed = false
let cachedBindings: ParsedBinding[] | null = null
let cachedWarnings: KeybindingWarning[] = []
let unsubscribeGateChanges: (() => void) | null = null
let gateEnabled: boolean | null = null
/**
 * Bumped on every gate transition. Async work that reads the gate before an
 * await captures this and bails if it changed, so a load started while the
 * gate was on cannot commit its result after the kill switch has been thrown.
 */
let gateGeneration = 0
let initializing: Promise<void> | null = null
/** Resolves once a watcher being torn down has really closed. */
let watcherClosing: Promise<void> | null = null
let cleanupRegistered = false
const keybindingsChanged = createSignal<[result: KeybindingsLoadResult]>()

/**
 * Tracks the date (YYYY-MM-DD) when we last logged a custom keybindings load event.
 * Used to ensure we fire the event at most once per day.
 */
let lastCustomBindingsLogDate: string | null = null

/**
 * Log a telemetry event when custom keybindings are loaded, at most once per day.
 * This lets us estimate the percentage of users who customize their keybindings.
 */
function logCustomBindingsLoadedOncePerDay(userBindingCount: number): void {
  const today = new Date().toISOString().slice(0, 10)
  if (lastCustomBindingsLogDate === today) return
  lastCustomBindingsLogDate = today
  logEvent('tengu_custom_keybindings_loaded', {
    user_binding_count: userBindingCount,
  })
}

/**
 * Type guard to check if an object is a valid KeybindingBlock.
 */
function isKeybindingBlock(obj: unknown): obj is KeybindingBlock {
  if (typeof obj !== 'object' || obj === null) return false
  const b = obj as Record<string, unknown>
  return (
    typeof b.context === 'string' &&
    typeof b.bindings === 'object' &&
    b.bindings !== null
  )
}

/**
 * Type guard to check if an array contains only valid KeybindingBlocks.
 */
function isKeybindingBlockArray(arr: unknown): arr is KeybindingBlock[] {
  return Array.isArray(arr) && arr.every(isKeybindingBlock)
}

/**
 * Get the path to the user keybindings file.
 */
export function getKeybindingsPath(): string {
  return join(getClaudeConfigHomeDir(), 'keybindings.json')
}

/**
 * Parse default bindings (cached for performance).
 */
function getDefaultParsedBindings(): ParsedBinding[] {
  return parseBindings(DEFAULT_BINDINGS)
}

/**
 * Load and parse keybindings from user config file.
 * Returns merged default + user bindings along with validation warnings.
 *
 * Returns default bindings only when the gate is off.
 */
export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  const defaultBindings = getDefaultParsedBindings()

  // Skip user config loading when the gate is off
  if (!isKeybindingCustomizationEnabled()) {
    return { bindings: defaultBindings, warnings: [] }
  }

  const userPath = getKeybindingsPath()

  try {
    const content = await readFile(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // Extract bindings array from object wrapper format: { "bindings": [...] }
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // Invalid format - missing bindings property
      const errorMessage = 'keybindings.json must have a "bindings" array'
      const suggestion = 'Use format: { "bindings": [ ... ] }'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    // Validate structure - bindings must be an array of valid keybinding blocks
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      logForDebugging(`[keybindings] Invalid keybindings.json: ${errorMessage}`)
      return {
        bindings: defaultBindings,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )

    // User bindings come after defaults, so they override
    const mergedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // Run validation on user config
    // First check for duplicate keys in raw JSON (JSON.parse silently drops earlier values)
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    const warnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, mergedBindings),
    ]

    if (warnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${warnings.length} validation issue(s)`,
      )
    }

    return { bindings: mergedBindings, warnings }
  } catch (error) {
    // File doesn't exist - use defaults (user can run /keybindings to create)
    if (isENOENT(error)) {
      return { bindings: defaultBindings, warnings: [] }
    }

    // Other error - log and return defaults with warning
    logForDebugging(
      `[keybindings] Error loading ${userPath}: ${errorMessage(error)}`,
    )
    return {
      bindings: defaultBindings,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `Failed to parse keybindings.json: ${errorMessage(error)}`,
        },
      ],
    }
  }
}

/**
 * Load keybindings synchronously (for initial render).
 * Uses cached value if available.
 */
export function loadKeybindingsSync(): ParsedBinding[] {
  if (cachedBindings) {
    return cachedBindings
  }

  const result = loadKeybindingsSyncWithWarnings()
  return result.bindings
}

/**
 * Load keybindings synchronously with validation warnings.
 * Uses cached values if available.
 *
 * Returns default bindings only when the gate is off.
 */
export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  if (cachedBindings) {
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const defaultBindings = getDefaultParsedBindings()

  // Skip user config loading when the gate is off
  if (!isKeybindingCustomizationEnabled()) {
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }

  const userPath = getKeybindingsPath()

  try {
    // sync IO: called from sync context (React useState initializer)
    const content = readFileSync(userPath, 'utf-8')
    const parsed: unknown = jsonParse(content)

    // Extract bindings array from object wrapper format: { "bindings": [...] }
    let userBlocks: unknown
    if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
      userBlocks = (parsed as { bindings: unknown }).bindings
    } else {
      // Invalid format - missing bindings property
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: 'keybindings.json must have a "bindings" array',
          suggestion: 'Use format: { "bindings": [ ... ] }',
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    // Validate structure - bindings must be an array of valid keybinding blocks
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      cachedBindings = defaultBindings
      cachedWarnings = [
        {
          type: 'parse_error',
          severity: 'error',
          message: errorMessage,
          suggestion,
        },
      ]
      return { bindings: cachedBindings, warnings: cachedWarnings }
    }

    const userParsed = parseBindings(userBlocks)
    logForDebugging(
      `[keybindings] Loaded ${userParsed.length} user bindings from ${userPath}`,
    )
    cachedBindings = [...defaultBindings, ...userParsed]

    logCustomBindingsLoadedOncePerDay(userParsed.length)

    // Run validation - check for duplicate keys in raw JSON first
    const duplicateKeyWarnings = checkDuplicateKeysInJson(content)
    cachedWarnings = [
      ...duplicateKeyWarnings,
      ...validateBindings(userBlocks, cachedBindings),
    ]
    if (cachedWarnings.length > 0) {
      logForDebugging(
        `[keybindings] Found ${cachedWarnings.length} validation issue(s)`,
      )
    }

    return { bindings: cachedBindings, warnings: cachedWarnings }
  } catch {
    // File doesn't exist or error - use defaults (user can run /keybindings to create)
    cachedBindings = defaultBindings
    cachedWarnings = []
    return { bindings: cachedBindings, warnings: cachedWarnings }
  }
}

/**
 * Follow the gate for the life of the process, in both directions.
 *
 * The loaders memoise whatever they returned and initializeKeybindingWatcher()
 * is only ever called once, so without this a value observed at startup would
 * be permanent: a gate arriving late could never turn customization on, and a
 * kill switch thrown later could never turn it off.
 */
/**
 * Tear the watcher down, keeping hold of the close so a watcher created
 * afterwards cannot overlap with it: close() is async while `watcher` is
 * cleared immediately, and an off/on cycle inside that window would otherwise
 * leave two watchers emitting reloads.
 */
function closeWatcher(): void {
  if (!watcher) return
  const closing = watcher.close()
  watcher = null
  watcherClosing = Promise.resolve(closing).catch(() => {})
}

/**
 * Drop anything loaded from the user's file and fall back to the defaults.
 *
 * Only emits when something is actually being discarded: user bindings are
 * always appended to the defaults, so a differing length is the cache holding
 * something the gate no longer allows, and warnings have to count too — a
 * malformed config caches the defaults but leaves its errors on screen.
 * Staying quiet otherwise keeps startup from emitting a change nobody made.
 */
function revertToDefaultBindings(): void {
  const defaultBindings = getDefaultParsedBindings()
  const hadUserState =
    (cachedBindings !== null &&
      cachedBindings.length !== defaultBindings.length) ||
    cachedWarnings.length > 0

  cachedBindings = defaultBindings
  cachedWarnings = []

  if (hadUserState) {
    keybindingsChanged.emit({ bindings: defaultBindings, warnings: [] })
  }
}

function watchGateChanges(): void {
  if (unsubscribeGateChanges) return

  unsubscribeGateChanges = onGrowthBookRefresh(() => {
    if (disposed) return

    const enabled = isKeybindingCustomizationEnabled()
    if (enabled === gateEnabled) return
    gateEnabled = enabled
    gateGeneration++

    if (!enabled) {
      logForDebugging('[keybindings] Gate disabled after startup - reverting')
      initialized = false
      closeWatcher()
      revertToDefaultBindings()
      return
    }

    logForDebugging('[keybindings] Gate enabled after startup - reloading')
    cachedBindings = null
    cachedWarnings = []
    void reinitializeAfterGateEnabled()
  })
}

/**
 * Bring the watcher up after the gate turned on, then publish the result.
 *
 * The first call can join an initialization that started before the gate
 * moved; that one skips installing a watcher because its generation check
 * fires, which would otherwise leave customization enabled with nothing
 * watching the file for the rest of the process. Hence the second attempt.
 */
async function reinitializeAfterGateEnabled(): Promise<void> {
  const generation = gateGeneration

  await initializeKeybindingWatcher()
  if (disposed || generation !== gateGeneration) return

  if (!initialized) {
    await initializeKeybindingWatcher()
    if (disposed || generation !== gateGeneration) return
  }

  keybindingsChanged.emit(loadKeybindingsSyncWithWarnings())
}

/**
 * Initialize file watching for keybindings.json.
 * Call this once when the app starts.
 *
 * When the gate is off this installs no file watcher. Either way it subscribes
 * to GrowthBook refreshes for the life of the process: the gate is a runtime
 * kill switch, so a value arriving after startup has to be able to turn
 * customization on, and a later flip back to off has to revert to the
 * defaults immediately rather than waiting for the file to change.
 *
 * Safe to call concurrently: `initialized` is only set once the directory
 * check has resolved, so two overlapping calls would otherwise both get past
 * it and create a second chokidar watcher.
 */
export function initializeKeybindingWatcher(): Promise<void> {
  if (initializing) return initializing
  initializing = initializeWatcherOnce().finally(() => {
    initializing = null
  })
  return initializing
}

async function initializeWatcherOnce(): Promise<void> {
  if (initialized || disposed) return

  gateEnabled = isKeybindingCustomizationEnabled()
  watchGateChanges()

  // Skip file watching when the gate is off
  if (!gateEnabled) {
    logForDebugging(
      '[keybindings] Skipping file watcher - user customization disabled',
    )
    // The sync loader runs first and memoises its result, so the cache can
    // already hold bindings read while the gate was still on. Nothing would
    // re-check it: loadKeybindingsSync() returns the cache without consulting
    // the gate at all.
    revertToDefaultBindings()
    return
  }

  const generation = gateGeneration
  const userPath = getKeybindingsPath()
  const watchDir = dirname(userPath)

  // Only watch if parent directory exists
  try {
    const stats = await stat(watchDir)
    if (!stats.isDirectory()) {
      logForDebugging(
        `[keybindings] Not watching: ${watchDir} is not a directory`,
      )
      return
    }
  } catch {
    logForDebugging(`[keybindings] Not watching: ${watchDir} does not exist`)
    return
  }

  // A watcher torn down by the kill switch may still be closing; overlapping
  // with it would have both of them reporting the same file change.
  if (watcherClosing) await watcherClosing

  // The gate could have been thrown while the directory check was in flight;
  // installing the watcher now would outlive the kill switch until the next
  // refresh.
  if (disposed || generation !== gateGeneration) {
    logForDebugging('[keybindings] Gate changed during init - not watching')
    return
  }

  // Set initialized only after we've confirmed we can watch
  initialized = true

  logForDebugging(`[keybindings] Watching for changes to ${userPath}`)

  watcher = chokidar.watch(userPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: FILE_STABILITY_THRESHOLD_MS,
      pollInterval: FILE_STABILITY_POLL_INTERVAL_MS,
    },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  })

  // Handlers carry the generation they were installed under: a watcher torn
  // down by the kill switch can still have events queued, and delivering one
  // of those would speak for a gate state that no longer holds.
  watcher.on('add', path => void handleChange(path, generation))
  watcher.on('change', path => void handleChange(path, generation))
  watcher.on('unlink', path => handleDelete(path, generation))

  // Register cleanup. Once only: the watcher can be torn down and rebuilt
  // every time the gate is toggled, and each registration is a distinct
  // closure the global cleanup set would keep.
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => disposeKeybindingWatcher())
  }
}

/**
 * Clean up the file watcher.
 */
export function disposeKeybindingWatcher(): void {
  disposed = true
  unsubscribeGateChanges?.()
  unsubscribeGateChanges = null
  gateEnabled = null
  gateGeneration++
  closeWatcher()
  keybindingsChanged.clear()
}

/**
 * Subscribe to keybinding changes.
 * The listener receives the new parsed bindings when the file changes.
 */
export const subscribeToKeybindingChanges = keybindingsChanged.subscribe

async function handleChange(path: string, generation: number): Promise<void> {
  if (disposed || generation !== gateGeneration) return

  logForDebugging(`[keybindings] Detected change to ${path}`)

  try {
    const result = await loadKeybindings()

    // The gate may have been thrown while the file was being read; committing
    // now would put the user's bindings back after the kill switch.
    if (disposed || generation !== gateGeneration) {
      logForDebugging('[keybindings] Gate changed during load - discarding')
      return
    }

    cachedBindings = result.bindings
    cachedWarnings = result.warnings

    // Notify all listeners with the full result
    keybindingsChanged.emit(result)
  } catch (error) {
    logForDebugging(`[keybindings] Error reloading: ${errorMessage(error)}`)
  }
}

function handleDelete(path: string, generation: number): void {
  if (disposed || generation !== gateGeneration) return

  logForDebugging(`[keybindings] Detected deletion of ${path}`)

  // Reset to defaults when file is deleted
  const defaultBindings = getDefaultParsedBindings()
  cachedBindings = defaultBindings
  cachedWarnings = []

  keybindingsChanged.emit({ bindings: defaultBindings, warnings: [] })
}

/**
 * Get the cached keybinding warnings.
 * Returns empty array if no warnings or bindings haven't been loaded yet.
 */
export function getCachedKeybindingWarnings(): KeybindingWarning[] {
  return cachedWarnings
}

/**
 * Reset internal state for testing.
 */
export function resetKeybindingLoaderForTesting(): void {
  initialized = false
  disposed = false
  cachedBindings = null
  cachedWarnings = []
  lastCustomBindingsLogDate = null
  unsubscribeGateChanges?.()
  unsubscribeGateChanges = null
  gateEnabled = null
  gateGeneration++
  // An initialization still awaiting its stat() would otherwise be handed to
  // the next caller and then mutate state belonging to the reset run. The
  // generation bump above already makes it a no-op when it resumes.
  initializing = null
  cleanupRegistered = false
  closeWatcher()
  keybindingsChanged.clear()
}
