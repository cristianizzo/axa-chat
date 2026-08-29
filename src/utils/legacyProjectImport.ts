/**
 * Importing a Claude Code project layout into axa's.
 *
 * axa reads and writes `.axa/` and `AXA.md` only. A repo set up for Claude
 * Code holds the same things under `.claude/` and `CLAUDE.md`, and without
 * this they are simply invisible — the model would start with no project
 * instructions and none of the repo's skills, agents or settings, with nothing
 * on screen to say why. Rather than read both names for ever, axa offers once
 * to bring them across.
 *
 * Copy, never move. The source repo may still be used with Claude Code by the
 * same person or a colleague, and taking their files away to satisfy a rename
 * would be a poor trade. It also makes declining safe and re-running harmless.
 */

import { cp, lstat, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  LEGACY_LOCAL_MEMORY_FILE_NAME,
  LEGACY_MEMORY_FILE_NAME,
  LOCAL_MEMORY_FILE_NAME,
  MEMORY_FILE_NAME,
} from '../constants/product.js'
import { isENOENT } from './errors.js'
import { logError } from './log.js'

/**
 * Entries never copied out of a legacy config directory.
 *
 * `worktrees` is the one that matters. It holds whole git checkouts, so
 * copying it is unbounded — gigabytes, during a startup dialog — and every
 * copy carries a `.git` file still pointing at the admin directory registered
 * to the original path. Two working trees would then share one index and HEAD,
 * and the stale-worktree sweep would run `git status` in the copy and refresh
 * the original's index against different files. Corruption, not just waste.
 *
 * The rest is regenerated state with no value in a new location, and in
 * `backups` and `history` the volume is real.
 */
const NOT_WORTH_IMPORTING = new Set([
  'worktrees',
  'backups',
  'history',
  'file-history',
  'shell-snapshots',
  'statsig',
  'todos',
  'cache',
])

/** What a project has under the old names, and does not yet have under ours. */
export type LegacyProjectFindings = {
  /** CLAUDE.md exists and AXA.md does not. */
  memoryFile: boolean
  /** CLAUDE.local.md exists and AXA.local.md does not. */
  localMemoryFile: boolean
  /** .claude/ exists as a directory. */
  configDir: boolean
}

export function hasAnything(findings: LegacyProjectFindings): boolean {
  return findings.memoryFile || findings.localMemoryFile || findings.configDir
}

// lstat, so a symlink is not followed: lstat reports the link itself, and a
// link is neither a regular file nor a directory, so isFile()/isDirectory()
// return false for it. A symlinked CLAUDE.md or .claude/ therefore never counts
// as a real file/directory to import and is left alone rather than copied from
// wherever it points.
async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** lstat, so a symlink still counts as present (the link exists) but is not followed. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * What there is to import, or nothing.
 *
 * Anything axa already owns is reported as nothing to do, so a project part
 * way through an import is not offered the same work twice and an existing
 * AXA.md is never a candidate for being overwritten.
 */
export async function findLegacyProjectFiles(
  projectRoot: string,
): Promise<LegacyProjectFindings> {
  const [
    legacyMemory,
    ownMemory,
    legacyLocalMemory,
    ownLocalMemory,
    legacyDir,
  ] = await Promise.all([
    isFile(join(projectRoot, LEGACY_MEMORY_FILE_NAME)),
    isFile(join(projectRoot, MEMORY_FILE_NAME)),
    isFile(join(projectRoot, LEGACY_LOCAL_MEMORY_FILE_NAME)),
    isFile(join(projectRoot, LOCAL_MEMORY_FILE_NAME)),
    isDirectory(join(projectRoot, LEGACY_CONFIG_DIR_NAME)),
  ])

  return {
    memoryFile: legacyMemory && !ownMemory,
    localMemoryFile: legacyLocalMemory && !ownLocalMemory,
    // The directory is offered even when .axa/ exists: the two hold different
    // subdirectories more often than not, and the copy below never overwrites.
    configDir: legacyDir,
  }
}

export type ImportOutcome = {
  copiedMemoryFile: boolean
  copiedLocalMemoryFile: boolean
  /** Top-level entries copied out of .claude/, for reporting. */
  copiedFromConfigDir: string[]
  failures: Array<{ path: string; error: string }>
}

async function copyFileIfAbsent(
  from: string,
  to: string,
  outcome: ImportOutcome,
): Promise<boolean> {
  try {
    const content = await readFile(from, 'utf-8')
    // `wx` rather than a stat first: the check and the write are one
    // operation, so a file appearing in between cannot be clobbered.
    await writeFile(to, content, { encoding: 'utf-8', flag: 'wx' })
    return true
  } catch (error) {
    // Already there — the whole point is not to overwrite, so this is the
    // expected outcome, not a failure worth reporting.
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    if (isENOENT(error)) return false
    logError(error)
    // Name both ends of the failed copy: a read error points at the source,
    // a write error at the destination, and only naming `from` misattributes
    // the latter. Kept readable for the `could not copy ${path}: ${error}`
    // message in the import dialog.
    outcome.failures.push({ path: `${from} → ${to}`, error: String(error) })
    return false
  }
}

/**
 * Copy a Claude Code project's config into axa's.
 *
 * The config directory is copied wholesale rather than by an enumerated list
 * of subdirectories, so anything either product adds later is carried across
 * without this function needing to learn about it. `force: false` makes every
 * copy non-destructive: where both projects have a file, axa's wins and the
 * legacy one is left alone.
 */
export async function importLegacyProject(
  projectRoot: string,
  findings: LegacyProjectFindings,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    copiedMemoryFile: false,
    copiedLocalMemoryFile: false,
    copiedFromConfigDir: [],
    failures: [],
  }

  if (findings.memoryFile) {
    outcome.copiedMemoryFile = await copyFileIfAbsent(
      join(projectRoot, LEGACY_MEMORY_FILE_NAME),
      join(projectRoot, MEMORY_FILE_NAME),
      outcome,
    )
  }

  if (findings.localMemoryFile) {
    outcome.copiedLocalMemoryFile = await copyFileIfAbsent(
      join(projectRoot, LEGACY_LOCAL_MEMORY_FILE_NAME),
      join(projectRoot, LOCAL_MEMORY_FILE_NAME),
      outcome,
    )
  }

  if (findings.configDir) {
    const from = join(projectRoot, LEGACY_CONFIG_DIR_NAME)
    const to = join(projectRoot, CONFIG_DIR_NAME)
    try {
      const { readdir } = await import('fs/promises')
      await mkdir(to, { recursive: true })

      // Entry by entry rather than one cp of the whole tree, so the excluded
      // ones can be skipped and so the report says what was actually copied.
      const entries = await readdir(from, { withFileTypes: true })
      for (const entry of entries) {
        if (NOT_WORTH_IMPORTING.has(entry.name)) continue
        const target = join(to, entry.name)
        // A directory is merged rather than skipped: `force: false` keeps every
        // file axa already has and adds only what is missing, so an existing
        // `.axa/agents` must not stop the legacy agents inside it coming
        // across. A plain file that already exists is left alone — there is
        // nothing to merge and axa's copy wins.
        if (!entry.isDirectory() && (await exists(target))) continue
        try {
          await cp(join(from, entry.name), target, {
            recursive: true,
            force: false,
            errorOnExist: false,
            // Copy a symlink as a symlink instead of following it out of the
            // project — a linked directory is not ours to duplicate.
            verbatimSymlinks: true,
          })
          outcome.copiedFromConfigDir.push(entry.name)
        } catch (error) {
          logError(error)
          outcome.failures.push({
            path: `${join(from, entry.name)} → ${target}`,
            error: String(error),
          })
        }
      }
    } catch (error) {
      logError(error)
      outcome.failures.push({ path: `${from} → ${to}`, error: String(error) })
    }
  }

  return outcome
}
