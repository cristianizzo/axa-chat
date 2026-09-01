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

import type { Dirent } from 'fs'
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  LEGACY_LOCAL_MEMORY_FILE_NAME,
  LEGACY_MEMORY_FILE_NAME,
  LOCAL_MEMORY_FILE_NAME,
  MEMORY_FILE_NAME,
} from '../constants/product.js'
import { saveCurrentProjectConfig, saveGlobalConfig } from './config.js'
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

/** How the user left the import offer. */
export type LegacyProjectImportOutcome =
  | 'skipped'
  /** Declined for every project, not just this one. */
  | 'skipped-everywhere'
  | 'imported'
  | 'failed'

/**
 * Is there anything under `from` that `to` does not already have?
 *
 * Mirrors what {@link importLegacyProject} would actually copy, so the offer is
 * not made for work that would do nothing. Without this the offer survives its
 * own success: the import copies rather than moves, so `.claude/` is still
 * there afterwards and a bare "the directory exists" test stays true for ever,
 * leaving the answered-flag as the only thing suppressing the dialog.
 *
 * Recurses because directories are *merged* rather than skipped: an existing
 * `.axa/agents` does not mean the legacy `agents/` has nothing new inside it.
 * `NOT_WORTH_IMPORTING` applies at the top level only, matching the import,
 * which is also what keeps this cheap — the unbounded entries (`worktrees`,
 * `backups`, `history`) are excluded before any descent, and the walk stops at
 * the first thing missing, so the pre-import case returns almost immediately.
 * A full traversal only happens once `.axa/` already mirrors `.claude/`, and
 * only on launches where the offer has not yet been answered.
 *
 * Symlinks are not followed — `Dirent.isDirectory()` is false for a link and
 * `exists` uses `lstat` — so there is no cycle to guard against and nothing is
 * inspected outside the project. The one place this is laxer than the import:
 * `cp` will replace a *destination* symlink even with `force: false`, and this
 * reports such an entry as already present. Under-offering a clobber is the
 * right direction to be wrong in.
 */
async function hasUncopiedEntries(
  from: string,
  to: string,
  topLevel = true,
): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(from, { withFileTypes: true })
  } catch {
    // Unreadable is not "has something to copy": offering an import that is
    // guaranteed to fail would put the user back in the loop this exists to
    // break. The import reports the failure if they reach it another way.
    return false
  }

  for (const entry of entries) {
    if (topLevel && NOT_WORTH_IMPORTING.has(entry.name)) continue
    const target = join(to, entry.name)
    if (!(await exists(target))) return true
    if (
      entry.isDirectory() &&
      (await hasUncopiedEntries(join(from, entry.name), target, false))
    ) {
      return true
    }
  }
  return false
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
    // Offered when .axa/ exists too — the two hold different subdirectories
    // more often than not — but only while something inside is still missing.
    // `.claude/` is copied, never moved, so its mere existence is permanent and
    // cannot be the test.
    configDir:
      legacyDir &&
      (await hasUncopiedEntries(
        join(projectRoot, LEGACY_CONFIG_DIR_NAME),
        join(projectRoot, CONFIG_DIR_NAME),
      )),
  }
}

/**
 * Persist what the user answered, wherever they were asked.
 *
 * Shared by the startup offer and `/import-project` so the two cannot drift:
 * a decline typed into the command has to silence the next launch, or the
 * command becomes a way to be nagged again.
 *
 * `'failed'` writes nothing, leaving the offer to be made again. That branch is
 * defensive rather than live — `importLegacyProject` catches every per-entry
 * error and returns them in `failures`, so nothing currently throws past it.
 */
export function recordLegacyImportAnswer(
  outcome: LegacyProjectImportOutcome,
): void {
  if (outcome === 'failed') return
  saveCurrentProjectConfig(current => ({
    ...current,
    hasAnsweredLegacyProjectImport: true,
  }))
  // In addition to the per-project flag, not instead of it: the answer is about
  // this project too, so clearing the global one later must not resurrect the
  // prompt here.
  if (outcome === 'skipped-everywhere') {
    saveGlobalConfig(current => ({
      ...current,
      hasDeclinedLegacyProjectImportEverywhere: true,
    }))
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
 * without this function needing to learn about it. `force: false` means that
 * where both projects have a file, axa's wins and the legacy one is left alone.
 * It does not extend to symlinks: Node replaces a destination *link* even so.
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
