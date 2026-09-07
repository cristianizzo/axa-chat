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

  const source = join(homedir(), OLD_DIR_NAME)
  const destination = join(homedir(), NEW_DIR_NAME)

  if (!existsSync(source)) return

  try {
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
    const missing = entries.filter(entry => !existsSync(join(destination, entry)))
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

    rmSync(source, { recursive: true, force: true })
  } catch (error) {
    logError(new Error(`Failed to migrate ${source} to ${destination}: ${error}`))
  }
}
