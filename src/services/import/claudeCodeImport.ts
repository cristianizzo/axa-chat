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
import { dirname, join, relative } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { FileHandle } from 'fs/promises'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getUsername } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  utimes,
} from 'fs/promises'

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

/** What every pending file carries, whatever will be done to it. */
type PendingFileBase = {
  source: string
  destination: string
  /** How much will actually be transferred: the whole file, or just the tail. */
  bytes: number
  /** Carried over to the write so the conversation keeps its real date. */
  atimeMs: number
  mtimeMs: number
}

/**
 * A single file the import will act on.
 *
 * Note what is absent: there is no "overwrite". A file already in axa is never
 * replaced — it is copied if new, extended if the source grew, and otherwise
 * left alone.
 *
 * Discriminated on `action` so `appendFrom` exists exactly where it means
 * something. An append without an offset would restart at byte 0 and duplicate
 * the entire transcript into itself, so the type makes that unrepresentable
 * rather than leaving a default to be got right at every call site.
 */
export type PendingFile = PendingFileBase &
  (
    | { action: 'copy' }
    | { action: 'repair-date' }
    | {
        action: 'append'
        /**
         * Offset to resume from: the current size of axa's copy, already
         * verified to be a byte-for-byte prefix of the source.
         */
        appendFrom: number
      }
  )

/** The action alone, for callers that only need to name one. */
export type PendingAction = PendingFile['action']

/** Something the import could not do, and why. Always reported to the user. */
export type ImportProblem = { path: string; error: string }

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
  /**
   * Things the scan could not read, so they are absent from the counts above.
   * Carried into the result rather than dropped, so a permission problem is
   * visible instead of just making the import look smaller than it is.
   */
  unreadable: ImportProblem[]
  /**
   * Conversations that grew on both sides since the last import, so neither
   * copy contains the other. Deliberately left alone rather than merged or
   * overwritten.
   */
  conflicts: ImportProblem[]
}

export type ImportResult = {
  filesCopied: number
  /** Files that were already present and gained only the messages added since. */
  filesAppended: number
  /** Files that were already present and only had their date restored. */
  filesRepaired: number
  bytesCopied: number
  settingsImported: boolean
  configKeysImported: string[]
  credentialsImported: boolean
  /** Everything that could not be imported. Never silently dropped. */
  failures: ImportProblem[]
  /** Conversations left untouched because both copies had moved on. */
  conflicts: ImportProblem[]
}

/** True when the plan would change nothing. */
export function isEmptyPlan(plan: ImportPlan): boolean {
  return (
    plan.files.length === 0 &&
    // A plan that would do nothing but has something to say is not empty:
    // treating it as such would swallow the conflicts and the unreadable files
    // behind "everything has already been imported".
    plan.conflicts.length === 0 &&
    plan.unreadable.length === 0 &&
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

/** The outcome of deciding one file, including the outcomes that do no work. */
type FileDecision =
  | { action: 'copy' }
  | { action: 'repair-date' }
  | { action: 'append'; appendFrom: number }
  /** Nothing to do, or nothing that can be done safely. */
  | { action: 'skip' }
  /** The two copies have diverged; neither contains the other. */
  | { action: 'conflict' }
  /** Could not be compared, so nothing is known and nothing is done. */
  | { action: 'unreadable'; error: string }

/**
 * Decide what to do with one file.
 *
 * The invariant is that **a file already in axa is never replaced**. Resume an
 * imported conversation, say one thing, and axa's copy is longer than Claude
 * Code's — copying the source over it would silently delete every message added
 * since. Rather than choose a winner by comparing sizes or dates, the import
 * only ever adds: a file it has never seen is copied, and a file it has seen
 * can gain a tail, never lose one.
 *
 * Appending is only offered when axa's copy is a verified prefix of the source
 * (see comparePrefix) — which is the normal state of an append-only
 * transcript that grew in Claude Code after being imported. Anything else is a
 * conflict and is left alone.
 *
 * Dates matter as well as bytes. A transcript's mtime is when the conversation
 * was last touched, which is what `--resume` sorts by and what the project list
 * shows as "last used", so a copy stamped at import time collapses months of
 * history into one undifferentiated block. Comparing dates is what lets a
 * re-run repair an import made before they were preserved.
 */
async function decideFile(
  sourcePath: string,
  destinationPath: string,
  source: { size: number; mtimeMs: number },
  destination: { size: number; mtimeMs: number } | null,
): Promise<FileDecision> {
  if (!destination) return { action: 'copy' }

  // Whole seconds: filesystems disagree on sub-second precision, and a copy
  // differing only in the fraction is still faithful.
  const sourceTime = Math.floor(source.mtimeMs / 1000)
  const destinationTime = Math.floor(destination.mtimeMs / 1000)

  if (source.size === destination.size) {
    if (sourceTime === destinationTime) return { action: 'skip' }

    // Same length, different date. Which way round decides whether the bytes
    // need checking.
    if (destinationTime > sourceTime) {
      // axa's copy is newer than a source that has not been touched since —
      // the signature of a copy stamped at import time. Nothing could have
      // rewritten the source in between without moving its own date forward,
      // so the bytes are the ones we wrote. Verifying instead would mean
      // re-reading the whole store to confirm what the dates already establish.
      return { action: 'repair-date' }
    }

    // The source is newer at the same length, so it was rewritten rather than
    // appended to. Its date says nothing about whether the content still
    // matches, so read it.
    const rewritten = await comparePrefix(
      destinationPath,
      sourcePath,
      destination.size,
    )
    switch (rewritten.status) {
      case 'prefix':
        return { action: 'repair-date' }
      case 'differs':
        return { action: 'conflict' }
      case 'unreadable':
        return { action: 'unreadable', error: rewritten.error }
    }
  }

  // axa holds more than the source: the conversation was continued here, or
  // the source was truncated. Either way there is nothing to add.
  if (destination.size > source.size) return { action: 'skip' }

  // The source holds more — but only take the extra if everything axa already
  // has is unchanged underneath it. Otherwise the two have diverged.
  const comparison = await comparePrefix(
    destinationPath,
    sourcePath,
    destination.size,
  )
  switch (comparison.status) {
    case 'prefix':
      return { action: 'append', appendFrom: destination.size }
    case 'differs':
      return { action: 'conflict' }
    case 'unreadable':
      // Not a conflict: nothing is known about whether they diverged. Reported
      // as the IO error it is, so a permissions problem is fixable rather than
      // presented as "you changed this in both places".
      return { action: 'unreadable', error: comparison.error }
  }
}

/**
 * read() and write() may move fewer bytes than asked for, even on a regular
 * file. Treating a short read as "the file changed" or a short write as "done"
 * would mean a false conflict or a transcript missing bytes from its middle, so
 * both are driven to completion here rather than assumed.
 */
async function readFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      position + total,
    )
    if (bytesRead === 0) break
    total += bytesRead
  }
  return total
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let total = 0
  while (total < length) {
    const { bytesWritten } = await handle.write(
      buffer,
      total,
      length - total,
      position + total,
    )
    if (bytesWritten === 0) {
      throw new Error(`Write stalled after ${total} of ${length} bytes.`)
    }
    total += bytesWritten
  }
}

/** Compared in 1 MB chunks; large transcripts are routinely hundreds of MB. */
const PREFIX_COMPARE_CHUNK = 1024 * 1024

/**
 * Add the source's tail to axa's copy, starting at `from`.
 *
 * Writes at explicit offsets from `from` onwards, so the bytes already in the
 * file are never rewritten — the whole point of preferring this to a copy. Since
 * `from` has been verified as the length of a prefix, the result is exactly the
 * source's content.
 */
async function appendTail(
  sourcePath: string,
  destinationPath: string,
  from: number,
): Promise<void> {
  const sourceHandle = await open(sourcePath, 'r')
  try {
    // 'r+', not 'a': append mode writes at whatever the end happens to be when
    // each write lands. If axa appended to this transcript between the plan and
    // now — resuming the conversation during an import is entirely possible —
    // that would interleave the source's tail after messages it never preceded.
    const destinationHandle = await open(destinationPath, 'r+')
    try {
      const { size } = await destinationHandle.stat()
      if (size !== from) {
        // Someone wrote to it since it was checked, so the verified prefix no
        // longer describes the file. Reported as a failure rather than guessed
        // at; the next run re-plans against whatever it looks like then.
        throw new Error(
          `Grew from ${from} to ${size} bytes while the import was running; left unchanged.`,
        )
      }

      const buffer = Buffer.allocUnsafe(PREFIX_COMPARE_CHUNK)
      let offset = from
      try {
        for (;;) {
          const bytesRead = await readFully(
            sourceHandle,
            buffer,
            PREFIX_COMPARE_CHUNK,
            offset,
          )
          if (bytesRead === 0) break
          // Explicit position, for the same reason as 'r+'.
          await writeFully(destinationHandle, buffer, bytesRead, offset)
          offset += bytesRead
        }
      } catch (error) {
        // A failure part-way through — a full disk, an IO error — would leave
        // half a message on the end of the transcript. Cut back to the length
        // that was verified, so the file is exactly what it was before. The
        // next run re-plans and appends the whole tail again.
        await destinationHandle.truncate(from).catch(() => {})
        throw error
      }
    } finally {
      await destinationHandle.close()
    }
  } finally {
    await sourceHandle.close()
  }
}

type PrefixComparison =
  | { status: 'prefix' }
  | { status: 'differs' }
  | { status: 'unreadable'; error: string }

/**
 * Is axa's copy exactly the first `length` bytes of the source?
 *
 * This is what makes appending safe rather than a guess. Comparing sizes and
 * dates can only say the two files differ; it cannot tell a transcript that
 * simply grew from one that was rewritten. Reading the bytes can.
 *
 * "Cannot tell" is reported separately from "they differ". Treating an
 * unreadable file as a difference would tell the user they had edited the same
 * conversation in two places when the real problem is a permission they could
 * fix.
 *
 * Costs a full read of the destination, so it runs only for the few files that
 * actually grew since the last import — never on a first import, where nothing
 * exists to compare against.
 */
async function comparePrefix(
  destinationPath: string,
  sourcePath: string,
  length: number,
): Promise<PrefixComparison> {
  let destinationHandle
  let sourceHandle
  try {
    destinationHandle = await open(destinationPath, 'r')
    sourceHandle = await open(sourcePath, 'r')

    const destinationBuffer = Buffer.allocUnsafe(PREFIX_COMPARE_CHUNK)
    const sourceBuffer = Buffer.allocUnsafe(PREFIX_COMPARE_CHUNK)

    for (let offset = 0; offset < length; offset += PREFIX_COMPARE_CHUNK) {
      const size = Math.min(PREFIX_COMPARE_CHUNK, length - offset)
      const [destinationRead, sourceRead] = await Promise.all([
        readFully(destinationHandle, destinationBuffer, size, offset),
        readFully(sourceHandle, sourceBuffer, size, offset),
      ])
      if (destinationRead !== size || sourceRead !== size) {
        // Short read on a file that stat said was long enough: it is being
        // written, or truncated underneath us. Unverifiable, not different.
        return {
          status: 'unreadable',
          error: 'File changed size while it was being compared.',
        }
      }
      if (destinationBuffer.compare(sourceBuffer, 0, size, 0, size) !== 0) {
        return { status: 'differs' }
      }
    }
    return { status: 'prefix' }
  } catch (error) {
    return { status: 'unreadable', error: String(error) }
  } finally {
    await destinationHandle?.close()
    await sourceHandle?.close()
  }
}

async function collectPendingFiles(
  sourceRoot: string,
  destinationRoot: string,
  problems: ImportProblem[],
  conflicts: ImportProblem[],
): Promise<PendingFile[]> {
  const pending: PendingFile[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // Nothing downstream will hit this path again — the import only copies
      // what the scan found — so an unreadable directory has to be reported
      // here or it disappears without trace.
      problems.push({ path: dir, error: String(error) })
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
      let sourceStat
      try {
        sourceStat = await stat(sourcePath)
      } catch (error) {
        // A file that vanished between the readdir and the stat is not a
        // problem: there is nothing left to import. Anything else is.
        if (getErrnoCode(error) !== 'ENOENT') {
          problems.push({ path: sourcePath, error: String(error) })
        }
        continue
      }
      const destinationStat = await statOrNull(destinationPath)
      const decision = await decideFile(
        sourcePath,
        destinationPath,
        sourceStat,
        destinationStat,
      )
      if (decision.action === 'skip') continue
      if (decision.action === 'conflict') {
        // Reported rather than resolved: picking a winner would throw away one
        // side's messages, and only the user knows which history matters.
        conflicts.push({
          // The axa file, because that is the one the message is about: it is
          // the copy being kept, and the one the user would open to compare.
          path: destinationPath,
          error:
            'Changed here and in Claude Code since the last import, so neither ' +
            `contains the other. Kept as it is; ${sourcePath} is unchanged.`,
        })
        continue
      }
      if (decision.action === 'unreadable') {
        problems.push({ path: sourcePath, error: decision.error })
        continue
      }

      const common = {
        source: sourcePath,
        destination: destinationPath,
        atimeMs: sourceStat.atimeMs,
        mtimeMs: sourceStat.mtimeMs,
      }
      switch (decision.action) {
        case 'copy':
          pending.push({ ...common, action: 'copy', bytes: sourceStat.size })
          break
        case 'append':
          pending.push({
            ...common,
            action: 'append',
            appendFrom: decision.appendFrom,
            bytes: sourceStat.size - decision.appendFrom,
          })
          break
        case 'repair-date':
          pending.push({ ...common, action: 'repair-date', bytes: 0 })
          break
      }
    }
  }

  await walk(sourceRoot)
  return pending
}

/**
 * A file that is not there is a normal state — the user may never have used
 * that part of Claude Code. A file that is there but unreadable or corrupt is
 * not, and has to be told apart so it can be reported instead of quietly
 * importing nothing.
 */
type JsonFile =
  | { status: 'ok'; value: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'unreadable'; error: string }

async function readJsonFile(path: string): Promise<JsonFile> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return { status: 'missing' }
    return { status: 'unreadable', error: String(error) }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'unreadable', error: 'File is not a JSON object.' }
    }
    return { status: 'ok', value: parsed as Record<string, unknown> }
  } catch (error) {
    return { status: 'unreadable', error: String(error) }
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

/**
 * Read the source install's stored credentials, without touching axa's own.
 *
 * Anything that goes wrong is appended to `problems`: a corrupt keychain entry
 * or credentials file is the difference between "you are still signed in" and
 * "log in again", so it cannot be swallowed.
 */
async function readSourceCredentials(
  problems: ImportProblem[],
): Promise<StoredCredentials | null> {
  if (process.platform === 'darwin') {
    const { stdout, code } = await execFileNoThrow(
      'security',
      [
        'find-generic-password',
        '-a',
        // The same resolution the storage layer uses to write entries, so a
        // launch context without $USER set (a LaunchAgent, an IDE) still finds
        // the account Claude Code stored the credentials under.
        getUsername(),
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
        problems.push({
          path: CLAUDE_CODE_KEYCHAIN_SERVICE,
          error: 'Keychain entry is not a JSON object.',
        })
        return null
      } catch (error) {
        problems.push({
          path: CLAUDE_CODE_KEYCHAIN_SERVICE,
          error: String(error),
        })
        return null
      }
    }
    // Fall through: a keychain miss is normal for an install that stored
    // credentials as a plain file instead.
  }

  const file = await readJsonFile(CLAUDE_CODE_CREDENTIALS_FILE)
  if (file.status === 'unreadable') {
    problems.push({ path: CLAUDE_CODE_CREDENTIALS_FILE, error: file.error })
  }
  return file.status === 'ok' ? (file.value as StoredCredentials) : null
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
    unreadable: [],
    conflicts: [],
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

  const unreadable: ImportProblem[] = []
  const conflicts: ImportProblem[] = []

  const sourceProjects = join(CLAUDE_CODE_DIR, 'projects')
  const files = (await statOrNull(sourceProjects))?.isDirectory()
    ? await collectPendingFiles(
        sourceProjects,
        join(destinationDir, 'projects'),
        unreadable,
        conflicts,
      )
    : []

  // Counted over new files only, because that is the line it is shown on:
  // "N new conversation files across M projects". An append lands in a project
  // that is already here and a date repair moves nothing, so counting either
  // would overstate how much is arriving.
  const projects = new Set(
    files
      .filter(file => file.action === 'copy')
      .map(
        file => relative(sourceProjects, file.source).split(/[/\\]/)[0] ?? '',
      ),
  )

  const sourceSettings = join(CLAUDE_CODE_DIR, 'settings.json')
  const destinationSettings = join(destinationDir, 'settings.json')
  const settings =
    !!(await statOrNull(sourceSettings)) &&
    !(await statOrNull(destinationSettings))

  const sourceConfig = await readJsonFile(CLAUDE_CODE_CONFIG_FILE)
  if (sourceConfig.status === 'unreadable') {
    unreadable.push({
      path: CLAUDE_CODE_CONFIG_FILE,
      error: sourceConfig.error,
    })
  }
  const { getGlobalConfig } = await import('../../utils/config.js')
  const destinationConfig = getGlobalConfig() as unknown as Record<
    string,
    unknown
  >
  const configKeys =
    sourceConfig.status === 'ok'
      ? IMPORTED_CONFIG_KEYS.filter(
          key =>
            sourceConfig.value[key] !== undefined &&
            destinationConfig[key] === undefined,
        )
      : []

  // Only offer the login if axa is not already signed in. Same rule as the
  // config keys: an import adds what is missing, it never replaces what is
  // there.
  const source = await readSourceCredentials(unreadable)
  const own = readOwnCredentials()
  const credentials =
    source !== null && Object.keys(source).some(key => own[key] === undefined)

  return {
    sourceDir: CLAUDE_CODE_DIR,
    destinationDir,
    available: true,
    files,
    // Only what will actually be transferred: a whole file for a copy, just the
    // new tail for an append, nothing for a date repair.
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    projects: projects.size,
    settings,
    configKeys: [...configKeys],
    credentials,
    unreadable,
    conflicts,
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
    filesAppended: 0,
    filesRepaired: 0,
    bytesCopied: 0,
    settingsImported: false,
    configKeysImported: [],
    credentialsImported: false,
    failures: [],
    conflicts: plan.conflicts,
  }

  const createdDirs = new Set<string>()
  for (const file of plan.files) {
    const dir = dirname(file.destination)
    try {
      if (!createdDirs.has(dir)) {
        await mkdir(dir, { recursive: true })
        createdDirs.add(dir)
      }
      switch (file.action) {
        case 'repair-date':
          result.filesRepaired++
          break
        case 'append':
          await appendTail(file.source, file.destination, file.appendFrom)
          result.bytesCopied += file.bytes
          result.filesAppended++
          break
        case 'copy':
          await copyFile(file.source, file.destination)
          result.bytesCopied += file.bytes
          result.filesCopied++
          break
      }
      // After the write, not before: writing sets mtime to now.
      await utimes(
        file.destination,
        new Date(file.atimeMs),
        new Date(file.mtimeMs),
      )
    } catch (error) {
      result.failures.push({ path: file.source, error: String(error) })
    }
    onProgress?.(
      result.filesCopied +
        result.filesAppended +
        result.filesRepaired +
        result.failures.length,
      plan.files.length,
    )
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
    if (sourceConfig.status !== 'ok') {
      // The plan only listed keys because this file parsed a moment ago, so
      // failing to read it now means something changed underneath us. Report
      // it: the user is expecting those keys.
      result.failures.push({
        path: CLAUDE_CODE_CONFIG_FILE,
        error:
          sourceConfig.status === 'missing'
            ? 'File disappeared after the import was planned.'
            : sourceConfig.error,
      })
    } else {
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
            if (
              next[key] === undefined &&
              sourceConfig.value[key] !== undefined
            ) {
              next[key] = sourceConfig.value[key]
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
    const source = await readSourceCredentials(result.failures)
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

  // Appended last so the progress callback's `filesDone + failures` count stays
  // a count of files. These were already unreadable at planning time, so they
  // never had a copy attempt of their own.
  result.failures.push(...plan.unreadable)

  logForDebugging(
    `Claude Code import: ${result.filesCopied} copied, ${result.filesAppended} appended, ${result.filesRepaired} repaired, ${result.failures.length} failures`,
  )
  return result
}
