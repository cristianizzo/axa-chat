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
        if (aLink.isSymbolicLink() || bLink.isSymbolicLink()) return false

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

    // `entries` is a snapshot taken before the copy, but rmSync removes the
    // tree as it stands now. An older session still writing into ~/.axa during
    // the copy would have its new entries deleted having never been copied.
    // Re-read and refuse on any difference in either direction.
    const before = new Set(entries)
    const after = readdirSync(source)
    const added = after.filter(entry => !before.has(entry))
    const removed = entries.filter(entry => !after.includes(entry))
    if (added.length > 0 || removed.length > 0) {
      const changes = [
        added.length > 0 ? `appeared: ${added.join(', ')}` : null,
        removed.length > 0 ? `disappeared: ${removed.join(', ')}` : null,
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
