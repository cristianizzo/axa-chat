/**
 * `--project <name>`: store this run's conversation under a project of the
 * caller's choosing rather than one derived from the current directory.
 *
 * This exists for wrappers that run axa from a scratch directory. The
 * polymarket bot creates a fresh `mkdtemp(prefix="pmbot-axa-")` per launch —
 * deliberately, so a stray project CLAUDE.md cannot leak into its context and
 * nobody can plant a config in a world-writable folder — and the cost of that
 * correct decision was 1,504 conversations scattered across seven unrelated
 * projects, one per temp directory. `--project pmbot` lets the bot keep its
 * isolated cwd and still write everything to one place.
 */

import { join } from 'path'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { getProjectsDir, sanitizePath } from '../../utils/sessionStoragePortable.js'

/**
 * Point the running session's transcripts at the named project.
 *
 * The name goes through the same sanitizer as a cwd, so it cannot contain a
 * path separator and cannot escape the projects directory. It also cannot
 * collide with a directory-derived project by accident: those are sanitized
 * absolute paths, so on unix they always begin with `-`.
 *
 * Returns the directory chosen, for the caller to log.
 */
export function pinSessionToProject(name: string): string {
  const dir = join(getProjectsDir(), sanitizePath(name))
  // switchSession is the only way to set the project dir, by design — it keeps
  // the session id and the directory atomic so they cannot drift (CC-34).
  // Passing the current id changes only where the transcript is written.
  switchSession(getSessionId(), dir)
  return dir
}
