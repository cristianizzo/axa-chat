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
 * Names Windows refuses to use for a directory, whatever the extension.
 *
 * Checked on every platform, not just Windows: a `~/.axa` copied from a Mac to
 * a Windows machine should not arrive holding a directory that cannot be
 * opened there.
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Turn a user-supplied name into a directory name.
 *
 * sanitizePath does the security work — the result cannot contain a path
 * separator, so it cannot escape the projects directory. It cannot collide
 * with a directory-derived project either: those are sanitized absolute paths,
 * so on unix they always begin with `-`.
 *
 * What it does not do is avoid the Windows device names, where `--project con`
 * would produce a directory that cannot be created and every later write would
 * fail. Those get a suffix.
 */
function toDirectoryName(name: string): string {
  const sanitized = sanitizePath(name)
  return WINDOWS_RESERVED_NAMES.test(sanitized)
    ? `${sanitized}-project`
    : sanitized
}

/**
 * Point the running session's transcripts at the named project.
 *
 * Returns the directory chosen, for the caller to log.
 */
export function pinSessionToProject(name: string): string {
  const dir = join(getProjectsDir(), toDirectoryName(name))
  // switchSession is the only way to set the project dir, by design — it keeps
  // the session id and the directory atomic so they cannot drift (CC-34).
  // Passing the current id changes only where the transcript is written.
  switchSession(getSessionId(), dir)
  return dir
}
