/**
 * Import an existing Claude Code installation into axa.
 *
 * axa owns `~/.axa` outright and starts empty, so a user coming from Claude
 * Code would otherwise lose their history and have to log in again. This module
 * copies that state across on demand.
 *
 * Two invariants, both load-bearing:
 *
 * 1. **The source is read-only.** Nothing here moves, deletes or rewrites
 *    anything under `~/.claude`. A user can keep using Claude Code afterwards,
 *    and can re-run the import later to pick up whatever they did in the
 *    meantime.
 * 2. **Re-running is safe.** Files already imported are skipped unless the
 *    source has changed, and config values that already exist on the axa side
 *    are never overwritten — so an import cannot clobber work done in axa.
 */

import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { homedir } from 'os'
import { join, relative } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { copyFile, mkdir, readFile, readdir, stat } from 'fs/promises'

/** Where a Claude Code install keeps its data. */
export const CLAUDE_CODE_DIR = join(homedir(), '.claude')

/** Claude Code's global config file, beside its data directory rather than in it. */
const CLAUDE_CODE_CONFIG_FILE = join(homedir(), '.claude.json')

/**
 * Claude Code's macOS Keychain entry for OAuth credentials.
 *
 * Hardcoded rather than derived from getMacOsKeychainStorageServiceName(),
 * which now returns axa's own name — reading the source install means asking
 * for the upstream one explicitly.
 */
const CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Claude Code's credential file on platforms without a keychain. */
const CLAUDE_CODE_CREDENTIALS_FILE = join(CLAUDE_CODE_DIR, '.credentials.json')

/**
 * Global-config keys worth carrying over.
 *
 * An allowlist rather than a whole-file copy. Excluded on purpose:
 * `anonymousId`, `machineID`, `userID` and `numStartups` identify the install
 * and should be freshly generated for this one; everything matching `*Cache`,
 * the tip/notice counters and the experiment payloads are derived state that
 * refetches itself and would only import staleness.
 */
const IMPORTED_CONFIG_KEYS = [
  // Authentication — the "already logged in" part.
  'oauthAccount',
  'activeAuthProvider',
  'codexOAuth',
  'deepseekAuth',
  'kimiAuth',
  'ollamaAuth',
  'customApiKeyResponses',
  'modelByAuthProvider',
  // Preferences and global MCP server config.
  //
  // `projects` is deliberately absent even though it holds useful per-directory
  // state (trust decisions, allowed tools): saveGlobalConfig always rewrites
  // that key from the config it read, so any value passed in is dropped. Listing
  // it would report an import that never happened. The cost is that each
  // directory asks for trust once.
  'mcpServers',
  'theme',
  'autoUpdates',
  'hasCompletedOnboarding',
] as const

/** A single file the import would copy. */
type PendingFile = {
  source: string
  destination: string
  bytes: number
}

export type ImportPlan = {
  sourceDir: string
  destinationDir: string
  /** False when there is nothing to import from, or the source *is* the destination. */
  available: boolean
  /** Why the import cannot run, when `available` is false. */
  unavailableReason?: string
  files: PendingFile[]
  bytes: number
  /** Distinct project directories the pending files belong to. */
  projects: number
  settings: boolean
  configKeys: string[]
  credentials: boolean
}

export type ImportResult = {
  filesCopied: number
  bytesCopied: number
  settingsImported: boolean
  configKeysImported: string[]
  credentialsImported: boolean
  /** Files that could not be copied, with the reason. Never silently dropped. */
  failures: { path: string; error: string }[]
}

/** True when the plan would change nothing. */
export function isEmptyPlan(plan: ImportPlan): boolean {
  return (
    plan.files.length === 0 &&
    !plan.settings &&
    plan.configKeys.length === 0 &&
    !plan.credentials
  )
}

async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Should `source` replace `destination`?
 *
 * A transcript is append-only, so a size change means the source gained
 * messages after the last import. mtime covers rewrites that happen to land on
 * the same length.
 */
function needsCopy(
  source: { size: number; mtimeMs: number },
  destination: { size: number; mtimeMs: number } | null,
): boolean {
  if (!destination) return true
  return (
    source.size !== destination.size || source.mtimeMs > destination.mtimeMs
  )
}

async function collectPendingFiles(
  sourceRoot: string,
  destinationRoot: string,
): Promise<PendingFile[]> {
  const pending: PendingFile[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable directory contributes nothing to the plan; the import
      // itself will surface a failure if it later hits the same path.
      return
    }
    for (const entry of entries) {
      const sourcePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(sourcePath)
        continue
      }
      if (!entry.isFile()) continue

      const destinationPath = join(
        destinationRoot,
        relative(sourceRoot, sourcePath),
      )
      const [sourceStat, destinationStat] = await Promise.all([
        statOrNull(sourcePath),
        statOrNull(destinationPath),
      ])
      if (!sourceStat) continue
      if (needsCopy(sourceStat, destinationStat)) {
        pending.push({
          source: sourcePath,
          destination: destinationPath,
          bytes: sourceStat.size,
        })
      }
    }
  }

  await walk(sourceRoot)
  return pending
}

async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Credentials as stored: a bag of per-provider blocks, of which
 * `claudeAiOauth` is the Anthropic login.
 */
type StoredCredentials = Record<string, unknown> & { claudeAiOauth?: unknown }

/**
 * What axa already has.
 *
 * Note the shape: storage returns `{}` — not null — when there is nothing
 * stored, so emptiness has to be tested per key rather than on the object.
 */
function readOwnCredentials(): StoredCredentials {
  return (getSecureStorage().read() ?? {}) as StoredCredentials
}

/** Read the source install's stored credentials, without touching axa's own. */
async function readSourceCredentials(): Promise<StoredCredentials | null> {
  if (process.platform === 'darwin') {
    const { stdout, code } = await execFileNoThrow(
      'security',
      [
        'find-generic-password',
        '-a',
        process.env.USER ?? '',
        '-w',
        '-s',
        CLAUDE_CODE_KEYCHAIN_SERVICE,
      ],
      { useCwd: false, timeout: 10_000 },
    )
    if (code === 0 && stdout.trim()) {
      try {
        const parsed: unknown = JSON.parse(stdout.trim())
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as StoredCredentials
        }
        return null
      } catch {
        return null
      }
    }
    // Fall through: a keychain miss is normal for an install that stored
    // credentials as a plain file instead.
  }
  return await readJsonFile(CLAUDE_CODE_CREDENTIALS_FILE)
}

/**
 * Work out what an import would do, without doing any of it.
 *
 * Cheap enough to run for a confirmation prompt: it stats files rather than
 * reading them.
 */
export async function planClaudeCodeImport(): Promise<ImportPlan> {
  const destinationDir = getClaudeConfigHomeDir()
  const empty: ImportPlan = {
    sourceDir: CLAUDE_CODE_DIR,
    destinationDir,
    available: false,
    files: [],
    bytes: 0,
    projects: 0,
    settings: false,
    configKeys: [],
    credentials: false,
  }

  if (CLAUDE_CODE_DIR === destinationDir) {
    return {
      ...empty,
      unavailableReason:
        'CLAUDE_CONFIG_DIR points at the Claude Code directory, so there is nothing to import from.',
    }
  }
  if (!(await statOrNull(CLAUDE_CODE_DIR))?.isDirectory()) {
    return {
      ...empty,
      unavailableReason: `No Claude Code installation found at ${CLAUDE_CODE_DIR}.`,
    }
  }

  const sourceProjects = join(CLAUDE_CODE_DIR, 'projects')
  const files = (await statOrNull(sourceProjects))?.isDirectory()
    ? await collectPendingFiles(
        sourceProjects,
        join(destinationDir, 'projects'),
      )
    : []

  const projects = new Set(
    files.map(
      file => relative(sourceProjects, file.source).split(/[/\\]/)[0] ?? '',
    ),
  )

  const sourceSettings = join(CLAUDE_CODE_DIR, 'settings.json')
  const destinationSettings = join(destinationDir, 'settings.json')
  const settings =
    !!(await statOrNull(sourceSettings)) &&
    !(await statOrNull(destinationSettings))

  const sourceConfig = await readJsonFile(CLAUDE_CODE_CONFIG_FILE)
  const { getGlobalConfig } = await import('../../utils/config.js')
  const destinationConfig = getGlobalConfig() as unknown as Record<
    string,
    unknown
  >
  const configKeys = sourceConfig
    ? IMPORTED_CONFIG_KEYS.filter(
        key =>
          sourceConfig[key] !== undefined &&
          destinationConfig[key] === undefined,
      )
    : []

  // Only offer the login if axa is not already signed in. Same rule as the
  // config keys: an import adds what is missing, it never replaces what is
  // there.
  const source = await readSourceCredentials()
  const own = readOwnCredentials()
  const credentials =
    source !== null && Object.keys(source).some(key => own[key] === undefined)

  return {
    sourceDir: CLAUDE_CODE_DIR,
    destinationDir,
    available: true,
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    projects: projects.size,
    settings,
    configKeys: [...configKeys],
    credentials,
  }
}

/**
 * Execute a plan produced by planClaudeCodeImport().
 *
 * Per-file failures are collected and returned rather than aborting the run —
 * one unreadable transcript should not cost the user the other 1,500 — but they
 * are always reported, never swallowed.
 */
export async function runClaudeCodeImport(
  plan: ImportPlan,
  onProgress?: (filesDone: number, filesTotal: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = {
    filesCopied: 0,
    bytesCopied: 0,
    settingsImported: false,
    configKeysImported: [],
    credentialsImported: false,
    failures: [],
  }

  const createdDirs = new Set<string>()
  for (const file of plan.files) {
    const dir = file.destination.slice(0, file.destination.lastIndexOf('/'))
    try {
      if (!createdDirs.has(dir)) {
        await mkdir(dir, { recursive: true })
        createdDirs.add(dir)
      }
      await copyFile(file.source, file.destination)
      result.filesCopied++
      result.bytesCopied += file.bytes
    } catch (error) {
      result.failures.push({ path: file.source, error: String(error) })
    }
    onProgress?.(result.filesCopied + result.failures.length, plan.files.length)
  }

  if (plan.settings) {
    try {
      await mkdir(plan.destinationDir, { recursive: true })
      await copyFile(
        join(plan.sourceDir, 'settings.json'),
        join(plan.destinationDir, 'settings.json'),
      )
      result.settingsImported = true
    } catch (error) {
      result.failures.push({
        path: join(plan.sourceDir, 'settings.json'),
        error: String(error),
      })
    }
  }

  if (plan.configKeys.length > 0) {
    const sourceConfig = await readJsonFile(CLAUDE_CODE_CONFIG_FILE)
    if (sourceConfig) {
      const { saveGlobalConfig } = await import('../../utils/config.js')
      let imported: string[] = []
      try {
        // An updater rather than a read-modify-write: it runs under the config
        // lock against the current contents, so a value another process wrote
        // while the user was reading the confirmation cannot be clobbered.
        saveGlobalConfig(current => {
          const config = current as unknown as Record<string, unknown>
          const next: Record<string, unknown> = { ...config }
          // Reassigned, not appended to: the updater may run more than once.
          imported = []
          for (const key of plan.configKeys) {
            // Re-check rather than trusting the plan: the config may have
            // gained the key since it was made.
            if (next[key] === undefined && sourceConfig[key] !== undefined) {
              next[key] = sourceConfig[key]
              imported.push(key)
            }
          }
          // Returning the same reference means "nothing to write".
          return imported.length > 0 ? (next as never) : current
        })
        result.configKeysImported = imported
      } catch (error) {
        logError(error)
        result.failures.push({
          path: CLAUDE_CODE_CONFIG_FILE,
          error: String(error),
        })
      }
    }
  }

  if (plan.credentials) {
    const source = await readSourceCredentials()
    if (source) {
      // Merge the other way round from a spread: what axa already holds wins,
      // so importing can add a login but never invalidate one — a stale
      // refresh token overwriting a live one would sign the user out.
      const merged = { ...source, ...readOwnCredentials() }
      const { success, warning } = getSecureStorage().update(merged as never)
      result.credentialsImported = success
      if (!success) {
        result.failures.push({
          path: 'credentials',
          error: warning ?? 'Secure storage rejected the imported credentials.',
        })
      }
    }
  }

  logForDebugging(
    `Claude Code import: ${result.filesCopied} files, ${result.failures.length} failures`,
  )
  return result
}
