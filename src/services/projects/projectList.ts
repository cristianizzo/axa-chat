/**
 * Reading the project store: what is on disk under `~/.axa/projects`, how big
 * it is, and which real directory each project came from.
 *
 * Everything here is derived. There is no index and no metadata file — a
 * project is just a directory of transcripts, and the numbers come from
 * stat()ing them. That is deliberate: it means the list cannot drift out of
 * sync with the files, and a project that has never been customised costs no
 * extra storage.
 */

import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import {
  listCandidates,
  parseSessionInfoFromLite,
  type SessionInfo,
} from '../../utils/listSessionsImpl.js'
import {
  getProjectsDir,
  getTranscriptPath,
} from '../../utils/sessionStorage.js'
import {
  extractJsonStringField,
  readSessionLite,
  validateUuid,
} from '../../utils/sessionStoragePortable.js'

export type ProjectSummary = {
  /**
   * The directory name under `~/.axa/projects`, e.g.
   * `-Users-cristianizzo-Developers-axa-chat`. This is the project's identity
   * on disk — it is what every action has to operate on, because it is the
   * only thing guaranteed to be unique.
   */
  dirName: string
  /** Absolute path of that directory. */
  dir: string
  /**
   * The directory the user actually ran axa in.
   *
   * Recovered from the `cwd` field inside a transcript, never by decoding
   * `dirName`: sanitizePath maps every non-alphanumeric character to `-`, so
   * `/a/b-c` and `/a/b/c` both become `-a-b-c` and the encoding cannot be
   * reversed. Undefined when no transcript could be read — an orphaned
   * project, or one holding only sidecar data.
   */
  path?: string
  /** Top-level `*.jsonl` files: one per conversation. */
  conversations: number
  /** Everything under the directory, including backups and subagent logs. */
  bytes: number
  /** Newest mtime anywhere in the project. 0 when the project is empty. */
  lastUsed: number
  /** `path` was recovered but no longer exists on disk. */
  missingPath: boolean
  /**
   * No conversations left, but the directory still holds data — backups or
   * subagent transcripts whose parent transcript was deleted. Invisible and
   * unreclaimable before this list existed.
   */
  orphanedData: boolean
  /** Holds the running session's transcript, so it must not be moved away. */
  isCurrent: boolean
}

/**
 * How many file operations to keep in flight.
 *
 * The scan is recursive and fans out at every directory, so an unbounded
 * `Promise.all` would put the whole store — thousands of files here — in flight
 * at once and can exhaust the process's file descriptors (EMFILE). Wide enough
 * to keep the disk busy, narrow enough that it cannot.
 */
const SCAN_CONCURRENCY = 16

/** Like `Promise.all(items.map(fn))`, but with at most `limit` running. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  limit = SCAN_CONCURRENCY,
): Promise<void> {
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++
        const item = items[index]
        if (item === undefined) return
        await fn(item)
      }
    },
  )
  await Promise.all(workers)
}

type Walked = {
  bytes: number
  lastUsed: number
  /** Top-level transcripts only, newest first. */
  transcripts: { path: string; mtime: number }[]
}

/**
 * One pass over a project directory for size, recency and transcript list.
 *
 * Recursive because size has to include the sidecar directories — the single
 * largest thing in this store is a `subagents/` folder whose parent transcript
 * was deleted, and a top-level-only scan would report it as 0 bytes.
 */
async function walkProject(dir: string): Promise<Walked> {
  const walked: Walked = { bytes: 0, lastUsed: 0, transcripts: [] }

  async function visit(current: string, depth: number): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // Unreadable subtree: it contributes nothing rather than failing the
      // whole listing. The project still shows up with the sizes we could read.
      return
    }

    await mapWithConcurrency(entries, async entry => {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path, depth + 1)
        return
      }
      if (!entry.isFile()) return

      let fileStat
      try {
        fileStat = await stat(path)
      } catch {
        return
      }
      walked.bytes += fileStat.size
      const mtime = fileStat.mtime.getTime()
      if (mtime > walked.lastUsed) walked.lastUsed = mtime
      // Only `<uuid>.jsonl` at the top level is a conversation — the same
      // test listCandidates applies. Counting every .jsonl would inflate the
      // count with stray files and could hand readProjectPath a `cwd` taken
      // from something that is not a transcript at all.
      if (
        depth === 0 &&
        entry.name.endsWith('.jsonl') &&
        validateUuid(entry.name.slice(0, -'.jsonl'.length))
      ) {
        walked.transcripts.push({ path, mtime })
      }
    })
  }

  await visit(dir, 0)
  walked.transcripts.sort((a, b) => b.mtime - a.mtime)
  return walked
}

/**
 * Recover the directory the project's conversations were held in.
 *
 * Reads only the head of the newest transcript: `cwd` is written on every
 * line, so the first one is enough, and the newest file is the most likely to
 * reflect where the user is working now.
 */
async function readProjectPath(
  transcripts: { path: string }[],
): Promise<string | undefined> {
  for (const transcript of transcripts.slice(0, 3)) {
    const lite = await readSessionLite(transcript.path)
    if (!lite) continue
    const cwd = extractJsonStringField(lite.head, 'cwd')
    if (cwd) return cwd
  }
  return undefined
}

async function summarize(
  projectsDir: string,
  dirName: string,
  currentDir: string,
): Promise<ProjectSummary> {
  const dir = join(projectsDir, dirName)
  const walked = await walkProject(dir)
  const path = await readProjectPath(walked.transcripts)

  return {
    dirName,
    dir,
    path,
    conversations: walked.transcripts.length,
    bytes: walked.bytes,
    lastUsed: walked.lastUsed,
    missingPath: path !== undefined && !(await exists(path)),
    orphanedData: walked.transcripts.length === 0 && walked.bytes > 0,
    isCurrent: dir === currentDir,
  }
}

/**
 * A project directory with nothing whatsoever in it.
 *
 * These are litter, not projects: a directory is created for the current cwd
 * on every run, including runs that write nothing at all — a `-p` invocation
 * that fails at the login check still leaves one. Someone who works in many
 * folders would otherwise open this list and find it mostly empty rows.
 *
 * Kept distinct from `orphanedData`, which is a directory that holds real
 * bytes and therefore deserves to be seen and reclaimed.
 */
function isEmptyDirectory(project: ProjectSummary): boolean {
  return project.conversations === 0 && project.bytes === 0
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Every project in the store, newest first.
 *
 * Costs one stat per file — a few thousand on a large store, which is fast
 * enough to run on open, and avoids any cache that could show the user stale
 * sizes right after they delete something.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const projectsDir = getProjectsDir()
  const currentDir = getCurrentProjectDir()

  let entries: Dirent[]
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    // No store yet — a fresh install before the first conversation is saved.
    return []
  }

  // Bounded here too: each project's own scan already fans out internally, so
  // scanning every project at once would multiply the two.
  const summaries: ProjectSummary[] = []
  await mapWithConcurrency(
    entries.filter(entry => entry.isDirectory()),
    async entry => {
      summaries.push(await summarize(projectsDir, entry.name, currentDir))
    },
    4,
  )

  return summaries
    .filter(project => !isEmptyDirectory(project))
    .sort((a, b) => b.lastUsed - a.lastUsed)
}

/**
 * How many conversations to read titles for when a project is opened.
 *
 * The pmbot projects hold hundreds of one-shot conversations, and reading every
 * head and tail to render a screen that shows a dozen rows is wasted work. The
 * newest are the ones anyone scrolls to.
 */
const MAX_CONVERSATIONS_READ = 100

/**
 * The conversations inside one project, newest first.
 *
 * Reads straight from the project directory rather than going through
 * listSessions(), which resolves a *cwd* to a project. That indirection cannot
 * reach a project whose original directory has been deleted, or one whose real
 * path was never recovered — exactly the cases this screen exists to show.
 */
export async function listProjectConversations(
  dir: string,
): Promise<SessionInfo[]> {
  const candidates = await listCandidates(dir, true)
  candidates.sort((a, b) => b.mtime - a.mtime)

  // readSessionLite holds a descriptor per file, so this is batched rather than
  // opening a hundred at once.
  const sessions: SessionInfo[] = []
  await mapWithConcurrency(
    candidates.slice(0, MAX_CONVERSATIONS_READ),
    async candidate => {
      const lite = await readSessionLite(candidate.filePath)
      if (!lite) return
      const info = parseSessionInfoFromLite(candidate.sessionId, lite)
      if (!info) return
      info.lastModified = candidate.mtime
      sessions.push(info)
    },
  )

  return sessions.sort((a, b) => b.lastModified - a.lastModified)
}

/**
 * The project directory the running session writes to.
 *
 * Derived from getTranscriptPath() rather than recomputed from cwd, so it
 * cannot drift from where the transcript actually goes: after a resume or a
 * `--project` run the session writes somewhere other than the cwd-derived
 * directory, and marking the wrong project as current would let the user
 * delete the one they are typing into.
 */
function getCurrentProjectDir(): string {
  return dirname(getTranscriptPath())
}
