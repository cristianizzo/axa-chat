/**
 * One-time move of `~/.axa` into `~/.claude`.
 *
 * Runs before any config read: the existing migration set in main.tsx gates on
 * getGlobalConfig().migrationVersion, and that config lives in the directory
 * being moved. There is no version counter here because success deletes the
 * trigger — `~/.axa` no longer existing IS the "already ran" flag.
 *
 * Copy, verify, then delete, and never delete on a partial result. The source
 * holds credentials that cannot be reissued, so a half-migration that removed
 * the original would be unrecoverable. Every failure path leaves `~/.axa`
 * intact and simply retries next launch.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { logError } from './log.js'

const OLD_DIR_NAME = '.axa'
const NEW_DIR_NAME = '.claude'

/** Directories are identity-only: their size is filesystem noise, and any
 *  change to their contents shows up as a path of its own. */
const DIRECTORY_SENTINEL = -1

/**
 * Every path under `root`, relative to it, mapped to its size. lstat, never
 * stat: a link is a node here, not something to follow, so a dangling or
 * looping link neither throws nor walks out of the tree.
 *
 * Used for both the before and after snapshots so the two are comparable by
 * construction — a second, separately written walk would be its own bug.
 */
function snapshotTree(root: string): Map<string, number> {
  const sizes = new Map<string, number>()

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(dir, entry.name)

      // Vanished between the readdir and the lstat. Leaving it out is safe in
      // both directions: whichever snapshot lacks it, the two differ and the
      // caller refuses to delete.
      const stats = lstatSync(absolutePath, { throwIfNoEntry: false })
      if (!stats) continue

      const isDirectory = stats.isDirectory()
      sizes.set(relativePath, isDirectory ? DIRECTORY_SENTINEL : stats.size)
      if (isDirectory) walk(absolutePath, relativePath)
    }
  }

  walk(root, '')
  return sizes
}

/** Keeps the abort message readable when the difference is thousands of files. */
function summarize(label: string, paths: string[]): string | null {
  if (paths.length === 0) return null
  const shown = paths.slice(0, 5).join(', ')
  const rest = paths.length - 5
  return rest > 0 ? `${label}: ${shown} (+${rest} more)` : `${label}: ${shown}`
}

export function migrateAxaConfigDir(): void {
  // An explicit override names a location that is neither of these.
  if (process.env.CLAUDE_CONFIG_DIR) return

  // Resolved inside the try so an environment where homedir() throws is
  // reported rather than propagated — this function promises never to throw.
  // The catch reports these bare names if homedir() itself was what failed.
  let source = OLD_DIR_NAME
  let destination = NEW_DIR_NAME

  try {
    const home = homedir()
    source = join(home, OLD_DIR_NAME)
    destination = join(home, NEW_DIR_NAME)

    if (!existsSync(source)) return

    // getGlobalClaudeFile prefers `<configDir>/.config.json` when present, so a
    // Claude Code install carrying one would silently redirect the whole config
    // after the move. Refuse rather than guess.
    if (existsSync(join(destination, '.config.json'))) {
      logError(
        new Error(
          `Cannot migrate ${source}: ${destination}/.config.json exists and would override the migrated config. Move it aside and restart.`,
        ),
      )
      return
    }

    mkdirSync(destination, { recursive: true })

    const entries = readdirSync(source)
    // Recursive, and taken before a single byte is copied. The top-level entry
    // list above cannot see a concurrent session writing into an existing
    // subdirectory (~/.axa/projects/*.jsonl), which is the realistic racer.
    const sourceBefore = snapshotTree(source)
    const blocked: string[] = []

    for (const entry of entries) {
      const from = join(source, entry)
      const to = join(destination, entry)

      if (existsSync(to)) {
        blocked.push(entry)
        continue
      }

      cpSync(from, to, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      })
    }

    if (blocked.length > 0) {
      logError(
        new Error(
          `Migrated what it could from ${source}, but these already exist in ${destination} and were left behind: ${blocked.join(', ')}. ${source} has been kept.`,
        ),
      )
      return
    }

    // Verify before deleting. cpSync throwing is not the only failure mode.
    // existsSync follows links, so an entry copied verbatim as a dangling
    // symlink would report as missing and wedge the migration forever. lstat
    // sees the link itself: arriving as a link counts as arrived.
    const missing = entries.filter(
      entry =>
        !existsSync(join(destination, entry)) &&
        !lstatSync(join(destination, entry), { throwIfNoEntry: false }),
    )
    if (missing.length > 0) {
      logError(
        new Error(
          `Refusing to remove ${source}: ${missing.join(', ')} did not arrive in ${destination}.`,
        ),
      )
      return
    }

    const sizeMismatch = entries.filter(entry => {
      try {
        // Same dangling-link trap as the `missing` check above: statSync
        // follows links and throws on a dangling one, and the catch below
        // would read that as a mismatch. A link is copied verbatim, so its
        // arrival as a link is the check — never its target's size.
        const aLink = lstatSync(join(source, entry), { throwIfNoEntry: false })
        const bLink = lstatSync(join(destination, entry), {
          throwIfNoEntry: false,
        })
        if (!aLink || !bLink) return true
        // An asymmetry IS a mismatch: a link on one side and a real file on the
        // other is not a verified copy, in either direction.
        if (aLink.isSymbolicLink() !== bLink.isSymbolicLink()) return true
        if (aLink.isSymbolicLink()) return false

        const a = statSync(join(source, entry))
        const b = statSync(join(destination, entry))
        return a.isFile() && b.isFile() && a.size !== b.size
      } catch {
        return true
      }
    })
    if (sizeMismatch.length > 0) {
      logError(
        new Error(
          `Refusing to remove ${source}: ${sizeMismatch.join(', ')} differ in size at ${destination}.`,
        ),
      )
      return
    }

    // sourceBefore was taken before the copy, but rmSync removes the tree as it
    // stands now. A session still writing into ~/.axa during the copy would
    // have those bytes deleted having never been copied. Re-walk and refuse on
    // any difference in either direction, at any depth.
    //
    // The window between this read and the rmSync below cannot be closed
    // without locking, and is deliberately left open: the case worth catching
    // is a racer that wrote during the copy, which is orders of magnitude wider.
    const sourceAfter = snapshotTree(source)

    const appeared = [...sourceAfter.keys()].filter(
      relativePath => !sourceBefore.has(relativePath),
    )
    const disappeared = [...sourceBefore.keys()].filter(
      relativePath => !sourceAfter.has(relativePath),
    )
    const resized = [...sourceBefore.entries()]
      .filter(([relativePath, size]) => {
        const now = sourceAfter.get(relativePath)
        return now !== undefined && now !== size
      })
      .map(([relativePath]) => relativePath)

    if (appeared.length > 0 || disappeared.length > 0 || resized.length > 0) {
      const changes = [
        summarize('appeared', appeared),
        summarize('disappeared', disappeared),
        summarize('changed size', resized),
      ]
        .filter(Boolean)
        .join('; ')
      logError(
        new Error(
          `Refusing to remove ${source}: it changed while migrating (${changes}). ${source} has been kept.`,
        ),
      )
      return
    }

    rmSync(source, { recursive: true, force: true })
  } catch (error) {
    logError(new Error(`Failed to migrate ${source} to ${destination}: ${error}`))
  }
}
