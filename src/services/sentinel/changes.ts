import { lstat } from 'fs/promises'
import { resolve } from 'path'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'

/**
 * What changed in the working tree, as of one point in time.
 *
 * There is deliberately no filesystem watcher behind this. The sentinel only
 * ever acts at the end of a turn, so a watcher would burn resources tracking
 * events nobody reads, and would still have to reconcile with git to tell an
 * ignored build artifact from a real source edit. Asking git directly is both
 * cheaper and more accurate, and it sees edits made in an editor just as well.
 */
export type TreeChanges = {
  /**
   * Individual file paths relative to the git root, gitignore applied:
   * everything differing from HEAD plus everything untracked.
   *
   * Deliberately not sourced from `git status`, which collapses a wholly
   * untracked directory into a single `dir/` entry. That collapse breaks both
   * consumers — a file glob never matches `dir/`, and the repair would have to
   * recursively copy a directory rather than the files it actually cares about.
   */
  files: string[]
  /**
   * Cheap identity for this set of changes. Two snapshots with equal digests
   * describe the same tree, so the sentinel can skip re-verifying one it has
   * already judged.
   *
   * Built from each file's size and mtime rather than its contents. Content
   * hashing would be more precise but has to read every changed file; size and
   * mtime come from a stat, and every editor writes a new mtime on save. The
   * imprecision runs in the safe direction: a touch with no edit re-verifies
   * needlessly, which costs one command and reports nothing.
   */
  digest: string
}

const GIT_TIMEOUT_MS = 10_000

/**
 * List changed paths, or null when the question cannot be answered — no git,
 * not a repo, no commits yet, git too slow. Null means "do not act", never
 * "nothing changed": a sentinel that cannot see the tree must stay quiet
 * rather than assume it is clean and report a stale verdict.
 */
export async function getTreeChanges(
  gitRoot: string,
): Promise<TreeChanges | null> {
  // -z avoids git's path quoting, so paths with spaces, quotes or newlines
  // survive intact.
  //
  // `diff HEAD` rather than `status`: it names files individually and, for a
  // staged rename, names both the old and the new path — the old one having to
  // be mirrored as a deletion, or the repair worktree ends up holding two
  // copies of a moved file.
  const tracked = await execFileNoThrowWithCwd(
    'git',
    ['diff', 'HEAD', '--name-only', '-z'],
    { cwd: gitRoot, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )
  // Fails in a repository with no commits, where HEAD does not resolve. That
  // is a real repo state, but not one with a meaningful "what changed".
  if (tracked.code !== 0) return null

  const untracked = await execFileNoThrowWithCwd(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: gitRoot, timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
  )
  if (untracked.code !== 0) return null

  const files = [
    ...new Set([...splitZ(tracked.stdout), ...splitZ(untracked.stdout)]),
  ]
  if (files.length === 0) return { files: [], digest: 'clean' }

  return { files, digest: await stampDigest(gitRoot, files) }
}

/** The trailing NUL leaves an empty final element. */
function splitZ(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

/**
 * Fold every changed file's size and mtime into one string.
 *
 * The obvious alternative — hashing git's own output — does not work, and it
 * is worth saying why, because it looks like it should. `git status` prints
 * the same ` M path` however many times the file is edited, and `git ls-files
 * --stage` prints the *index* blob hash, which an unstaged edit never touches.
 * Two different broken versions of the same file therefore produce identical
 * output, and the sentinel would skip the second one entirely.
 */
async function stampDigest(gitRoot: string, files: string[]): Promise<string> {
  const stamps = await Promise.all(
    files.map(async file => {
      try {
        // lstat, so a symlink is stamped by the link rather than by whatever
        // it points at. Following it would stamp a file outside the repository
        // entirely, and a broken link would throw and read as deleted.
        const info = await lstat(resolve(gitRoot, file))
        return `${file}:${info.size}:${info.mtimeMs}`
      } catch {
        // Deleted since git listed it, which is itself a distinct tree state.
        return `${file}:gone`
      }
    }),
  )
  return hash(stamps.join('\0'))
}

/**
 * FNV-1a. Not cryptographic — this only needs to distinguish one tree state
 * from another, and avoiding a crypto import keeps the startup path light.
 */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
