/**
 * One-time move of `~/.axa` into `~/.claude`.
 *
 * Runs before any config read: the existing migration set in main.tsx gates on
 * getGlobalConfig().migrationVersion, and that config lives in the directory
 * being moved. There is no version counter here because success deletes the
 * trigger — `~/.axa` no longer existing IS the "already ran" flag.
 *
 * Merge, verify, then delete, and never delete on a partial result. The source
 * holds credentials that cannot be reissued, so a half-migration that removed
 * the original would be unrecoverable. Every failure path leaves `~/.axa`
 * intact and simply retries next launch.
 *
 * It is a merge and not a move because co-tenancy with a real Claude Code
 * install is intended: `~/.claude` is already populated on the mainline case.
 * The destination always wins a content conflict — that config is live — and
 * the source version is kept beside it as `<name>.from-axa`, so the delete
 * still loses nothing.
 */

import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
  rmSync,
  statSync,
  type Stats,
} from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { CONFIG_DIR_NAME, OLD_CONFIG_DIR_NAME } from '../constants/product.js'
import { logError } from './log.js'

// Imported, not spelled again: the permission layer protects the same two
// names, and a second literal here is how the two halves silently drift.
const OLD_DIR_NAME = OLD_CONFIG_DIR_NAME
const NEW_DIR_NAME = CONFIG_DIR_NAME

/** Suffix for a source file kept beside a differing destination file. The
 *  destination always wins a content conflict — it may be a real Claude Code
 *  install's live config — but nothing from `~/.axa` may be lost either. */
const PRESERVED_SUFFIX = '.from-axa'

/** Directories are identity-only: their own size and mtime are filesystem
 *  noise, and any change to their contents shows up as a path of its own. */
const DIRECTORY_SIGNATURE = 'd'

/**
 * Every path under `root`, relative to it, mapped to a signature. lstat, never
 * stat: a link is a node here, not something to follow, so a dangling or
 * looping link neither throws nor walks out of the tree.
 *
 * The signature is type + size + mtime + inode, not size alone. Size alone
 * misses the case this check exists for: a session rewriting a file in place at
 * the same length, or retargeting a symlink to a target of the same length,
 * during the migration. Those bytes were never copied, and a size-keyed
 * before/after comparison agrees they are unchanged — so the source would be
 * deleted. mtime catches a rewrite; inode catches a replace-by-rename that
 * happened to preserve both. Content hashing would be stronger still, but this
 * walk runs over the whole tree twice and `projects/` holds every transcript
 * ever recorded — stat is O(1) per entry, and defeating mtime *and* inode
 * requires a deliberate `utimes`, not an accidental racer.
 *
 * Used for both the before and after snapshots so the two are comparable by
 * construction — a second, separately written walk would be its own bug.
 */
function snapshotTree(root: string): Map<string, string> {
  const signatures = new Map<string, string>()

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(dir, entry.name)

      // Vanished between the readdir and the lstat. Leaving it out is safe in
      // both directions: whichever snapshot lacks it, the two differ and the
      // caller refuses to delete.
      const stats = lstatSync(absolutePath, { throwIfNoEntry: false })
      if (!stats) continue

      if (stats.isDirectory()) {
        signatures.set(relativePath, DIRECTORY_SIGNATURE)
        walk(absolutePath, relativePath)
        continue
      }

      const kind = stats.isSymbolicLink() ? 'l' : 'f'
      signatures.set(
        relativePath,
        `${kind}:${stats.size}:${stats.mtimeMs}:${stats.ino}`,
      )
    }
  }

  walk(root, '')
  return signatures
}

/** Keeps the abort message readable when the difference is thousands of files. */
function summarize(label: string, paths: string[]): string | null {
  if (paths.length === 0) return null
  const shown = paths.slice(0, 5).join(', ')
  const rest = paths.length - 5
  return rest > 0 ? `${label}: ${shown} (+${rest} more)` : `${label}: ${shown}`
}

/**
 * stderr, not stdout: this runs inside the commander `preAction` hook, ahead of
 * any command, so stdout may be a `-p` run's machine-readable output and must
 * not be written to. Never throws — a failed write must not take down startup.
 */
function announce(message: string): void {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    // A closed or broken stderr is not a reason to abort a migration.
  }
}

/** Only regular files and symlinks can be merged entry by entry. Anything else
 *  (fifo, socket, device) is not something to guess about. */
function isMergeable(stats: Stats): boolean {
  return stats.isFile() || stats.isSymbolicLink()
}

function describe(stats: Stats): string {
  if (stats.isDirectory()) return 'a directory'
  if (stats.isSymbolicLink()) return 'a symlink'
  if (stats.isFile()) return 'a file'
  return 'a special file'
}

const COMPARE_CHUNK_BYTES = 64 * 1024

/**
 * Byte comparison, never a size comparison: two `settings.json` of equal length
 * are routinely different files. Chunked rather than readFileSync so a large
 * transcript in ~/.axa/projects cannot exhaust memory here.
 */
function fileBytesEqual(a: string, b: string): boolean {
  const fdA = openSync(a, 'r')
  try {
    const fdB = openSync(b, 'r')
    try {
      const bufferA = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      const bufferB = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES)
      for (;;) {
        const readA = readSync(fdA, bufferA, 0, COMPARE_CHUNK_BYTES, null)
        const readB = readSync(fdB, bufferB, 0, COMPARE_CHUNK_BYTES, null)
        if (readA !== readB) return false
        if (readA === 0) return true
        if (!bufferA.subarray(0, readA).equals(bufferB.subarray(0, readB))) {
          return false
        }
      }
    } finally {
      closeSync(fdB)
    }
  } finally {
    closeSync(fdA)
  }
}

/**
 * Whether the destination entry already holds exactly what the source entry
 * holds. Callers have established that neither side is a directory and that
 * their symlink-ness matches.
 *
 * A symlink is compared by target, never by following it: the copy is
 * verbatim, so an identical target is an identical entry even when it dangles.
 */
function sameContent(
  from: string,
  fromStats: Stats,
  to: string,
  toStats: Stats,
): boolean {
  if (fromStats.isSymbolicLink()) return readlinkSync(from) === readlinkSync(to)
  if (fromStats.size !== toStats.size) return false
  return fileBytesEqual(from, to)
}

export function migrateAxaConfigDir(): void {
  // Resolved inside the try so an environment where homedir() throws is
  // reported rather than propagated — this function promises never to throw.
  // The catch reports these bare names if homedir() itself was what failed.
  let source = OLD_DIR_NAME
  let destination = NEW_DIR_NAME

  try {
    const home = homedir()
    source = join(home, OLD_DIR_NAME)
    destination = join(home, NEW_DIR_NAME)

    // An explicit override usually names a third location, which is neither
    // side of this migration and leaves nothing to do. But it may also spell
    // out the default destination, and `CLAUDE_CONFIG_DIR="$HOME/.claude"`
    // means exactly what leaving it unset means — that config home is the one
    // migrated *into*, so returning on the variable's mere presence would
    // strand ~/.axa forever for a user who only made the default explicit.
    // Compare the resolved paths instead. NFC on both sides for the same
    // reason getClaudeConfigHomeDir normalizes (utils/envUtils.ts): an
    // accented home directory can be spelled two ways and they are one
    // directory. An empty value is treated as unset, also matching that
    // function — `export CLAUDE_CONFIG_DIR=` and `unset` are one intent.
    // `~` is left unexpanded deliberately: nothing else expands it either, so
    // a literal `~/.claude` really is a third (relative) location here.
    //
    // Case-folded on win32 only. There, `c:\Users\me\.claude` and
    // `C:\Users\me\.claude` are one directory, and `resolve` keeps whatever
    // case it was given — so a case-exact compare would read the default,
    // spelled with a lowercase drive letter, as a third location and strand
    // ~/.axa exactly as before. Not folded on darwin, deliberately: APFS is
    // case-insensitive only *by default* and can be formatted otherwise, so
    // folding there risks the opposite and worse error — migrating into
    // ~/.claude while the user's config home is really ~/.CLAUDE, i.e. moving
    // credentials somewhere nothing reads. Not folding merely skips, which is
    // what this code did before the guard was touched at all.
    const foldCase = (path: string): string =>
      process.platform === 'win32' ? path.toLowerCase() : path
    const override = process.env.CLAUDE_CONFIG_DIR
    if (
      override &&
      foldCase(resolve(override).normalize('NFC')) !==
        foldCase(resolve(destination).normalize('NFC'))
    ) {
      return
    }

    // lstat, not existsSync: everything below assumes the source is a real
    // directory it can readdir. A regular file or a symlink named `.axa` would
    // otherwise reach readdirSync and throw ENOTDIR into the top-level catch,
    // producing a cryptic message on every launch forever. A symlink is refused
    // rather than followed: readdir would happily walk it, but rmSync at the end
    // removes the *link*, leaving the real directory orphaned and the migration
    // reporting success over data it did not move.
    const sourceStats = lstatSync(source, { throwIfNoEntry: false })
    if (!sourceStats) return
    if (!sourceStats.isDirectory()) {
      const kind = sourceStats.isSymbolicLink() ? 'a symlink' : 'not a directory'
      const message = `Cannot migrate ${source}: it is ${kind}. Move it aside and restart.`
      announce(message)
      logError(new Error(message))
      return
    }

    // getGlobalClaudeFile prefers `<configDir>/.config.json` over `config.json`
    // unconditionally (utils/env.ts), so this is not an ordinary file conflict
    // the merge below could settle: letting the destination's copy win would
    // leave it still overriding, and every migrated setting in `config.json`
    // would be silently ignored afterwards. The clash is over which file is read
    // at all, not over its contents. Refuse rather than guess.
    if (existsSync(join(destination, '.config.json'))) {
      // stderr as well as logError, for the same reason as every other refusal
      // path here: logError only reaches the console under HARD_FAIL, and this
      // check re-fires on every single launch until the user moves the file.
      // Silence makes a permanently blocked migration look like a completed one.
      const message = `Cannot migrate ${source}: ${destination}/.config.json exists and would override the migrated config. Move it aside and restart.`
      announce(message)
      logError(new Error(message))
      return
    }

    // The same guard as the source, in the other direction. `mkdirSync` with
    // `recursive: true` is a no-op on an existing directory but throws on an
    // existing *file*, and that throw lands in the top-level catch as a generic
    // message that repeats on every launch. A symlink is allowed here, unlike on
    // the source side: nothing deletes the destination, so there is no link to
    // orphan, and pointing ~/.claude at a dotfiles checkout is a real setup that
    // the rest of the config layer already follows. `statSync` follows the link
    // deliberately — what matters is what it resolves to — while a dangling link
    // resolves to nothing and is refused.
    const destinationLink = lstatSync(destination, { throwIfNoEntry: false })
    if (destinationLink) {
      const destinationTarget = statSync(destination, { throwIfNoEntry: false })
      if (!destinationTarget?.isDirectory()) {
        const kind = destinationTarget
          ? describe(destinationTarget)
          : 'a symlink that points nowhere'
        const message = `Cannot migrate ${source}: ${destination} is ${kind}, not a directory. Move it aside and restart.`
        announce(message)
        logError(new Error(message))
        return
      }
    }

    mkdirSync(destination, { recursive: true })

    // One read, not two. The merge's work list and the drift baseline must come
    // from the same observation of the directory: an entry created between two
    // separate reads would be missing from the merge loop yet present in both drift
    // snapshots, so it would be deleted uncopied and unlogged. Recursive, and
    // taken before a single byte is copied — this also catches a concurrent
    // session writing into an existing subdirectory (~/.axa/projects/*.jsonl),
    // which is the realistic racer.
    const sourceBefore = snapshotTree(source)

    // Sorted, so every parent is visited before its children: a path is a
    // string prefix of everything beneath it, so lexicographic order alone
    // guarantees it. `settled` below depends on that ordering.
    const relativePaths = [...sourceBefore.keys()].sort()

    // Co-tenancy with a real Claude Code install is intended, so ~/.claude is
    // populated on the mainline case and a top-level collision test would
    // block on nearly every entry. Merge instead: recurse where both sides are
    // directories, and decide per file. The merge is idempotent — an identical
    // file is "already migrated", not a conflict — so a run that ends in
    // `blocked` leaves a resumable state rather than one that re-blocks on its
    // own output.
    const blocked: string[] = []

    // Paths whose whole subtree was decided at the path itself: copied
    // verbatim, or blocked. Their children must not be visited again.
    const settled = new Set<string>()
    const hasSettledAncestor = (relativePath: string): boolean => {
      const parts = relativePath.split('/')
      let prefix = ''
      for (let index = 0; index < parts.length - 1; index++) {
        prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]
        if (settled.has(prefix)) return true
      }
      return false
    }

    // Source entries preserved beside a differing destination entry. The
    // verification pass must look at these paths, not at the colliding ones.
    const preserved = new Map<string, string>()

    // Sockets, FIFOs and device nodes found in the source: deliberately not
    // copied, and deliberately not required to arrive.
    const dropped = new Map<string, string>()

    const copyVerbatim = (from: string, to: string): void => {
      cpSync(from, to, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      })
    }

    for (const relativePath of relativePaths) {
      if (hasSettledAncestor(relativePath)) continue

      const from = join(source, relativePath)
      const to = join(destination, relativePath)

      // lstat, not existsSync: existsSync follows links and reports a dangling
      // one as absent, which would send a perfectly copyable symlink down the
      // wrong branch.
      const fromStats = lstatSync(from, { throwIfNoEntry: false })
      // Vanished since the snapshot. The drift check refuses the delete.
      if (!fromStats) continue

      const toStats = lstatSync(to, { throwIfNoEntry: false })

      // A socket, FIFO or device node. `cpSync` throws on these, and because
      // this branch is reached before any collision test, one stray socket in
      // ~/.axa would abort the entire migration from the top-level catch and do
      // it again on every launch. They are also not data: a socket is a kernel
      // object owned by a process that is gone, and copying it would produce
      // nothing a later run could use. Drop them by name rather than by silence,
      // and exempt them from the recoverability gate below — insisting they
      // "arrive" would wedge the migration permanently over entries that carry
      // no bytes to lose.
      if (!fromStats.isDirectory() && !isMergeable(fromStats)) {
        dropped.set(relativePath, `${relativePath} (${describe(fromStats)})`)
        settled.add(relativePath)
        continue
      }

      // Present only in the source: copy it as it stands, subtree and all.
      if (!toStats) {
        copyVerbatim(from, to)
        settled.add(relativePath)
        continue
      }

      // Directory on both sides: merge the children, never block the subtree
      // because the parent name is taken.
      if (fromStats.isDirectory() && toStats.isDirectory()) continue

      if (fromStats.isDirectory() !== toStats.isDirectory()) {
        blocked.push(
          `${relativePath} (${describe(fromStats)} in ${source}, ${describe(toStats)} in ${destination})`,
        )
        settled.add(relativePath)
        continue
      }

      // A link on one side and a real file on the other is a mismatch, not a
      // copy, in either direction.
      if (fromStats.isSymbolicLink() !== toStats.isSymbolicLink()) {
        blocked.push(
          `${relativePath} (${describe(fromStats)} in ${source}, ${describe(toStats)} in ${destination})`,
        )
        continue
      }

      if (!isMergeable(fromStats) || !isMergeable(toStats)) {
        blocked.push(`${relativePath} (${describe(fromStats)}, cannot be merged)`)
        continue
      }

      // Already migrated. Not a conflict.
      if (sameContent(from, fromStats, to, toStats)) continue

      // Both sides hold content and it differs. The destination wins — it may
      // be a live Claude Code config — but the source copy is kept beside it so
      // the delete below still loses nothing.
      const preservedPath = `${to}${PRESERVED_SUFFIX}`
      const preservedStats = lstatSync(preservedPath, { throwIfNoEntry: false })

      if (!preservedStats) {
        copyVerbatim(from, preservedPath)
        preserved.set(relativePath, preservedPath)
        continue
      }

      if (
        isMergeable(preservedStats) &&
        fromStats.isSymbolicLink() === preservedStats.isSymbolicLink() &&
        sameContent(from, fromStats, preservedPath, preservedStats)
      ) {
        // A previous run already preserved it.
        preserved.set(relativePath, preservedPath)
        continue
      }

      blocked.push(
        `${relativePath} (differs from ${destination}, and ${relativePath}${PRESERVED_SUFFIX} already exists with other contents)`,
      )
    }

    if (blocked.length > 0) {
      const details = summarize('unresolved', blocked)
      // stderr as well as logError: logError only reaches the console under
      // HARD_FAIL, and a migration that could not finish is something the user
      // has to act on — silence here reads as "nothing to do" and the block
      // then repeats on every launch forever.
      announce(
        `${source} could not be fully merged into ${destination} — ${details}. ${source} has been kept; resolve those by hand and restart.`,
      )
      logError(
        new Error(
          `Merged what it could from ${source} into ${destination}, but ${blocked.length} entr${blocked.length === 1 ? 'y' : 'ies'} could not be resolved — ${details}. ${source} has been kept; resolve these by hand and restart.`,
        ),
      )
      return
    }

    // Verify before deleting, at every depth rather than at the top level:
    // the merge descends into shared directories, so a top-level check would
    // now vouch for a directory name and nothing under it. cpSync throwing is
    // not the only failure mode.
    //
    // lstat throughout. existsSync and statSync both follow links and treat a
    // dangling one as absent or as a throw, and either would report an entry
    // copied verbatim as a dangling symlink as missing — wedging the migration
    // forever. A link arriving as a link with the same target is arrival.
    const missing: string[] = []
    const mismatched: string[] = []

    for (const relativePath of relativePaths) {
      // Never copied on purpose, and carrying no bytes to recover. Requiring
      // them here would refuse the delete forever over a dead socket.
      if (dropped.has(relativePath)) continue

      const from = join(source, relativePath)
      const fromStats = lstatSync(from, { throwIfNoEntry: false })
      // Vanished since the snapshot; the drift check below is what refuses.
      if (!fromStats) continue

      const to = preserved.get(relativePath) ?? join(destination, relativePath)
      const toStats = lstatSync(to, { throwIfNoEntry: false })
      if (!toStats) {
        missing.push(relativePath)
        continue
      }

      if (fromStats.isSymbolicLink() !== toStats.isSymbolicLink()) {
        mismatched.push(relativePath)
        continue
      }
      if (fromStats.isSymbolicLink()) {
        if (readlinkSync(from) !== readlinkSync(to)) mismatched.push(relativePath)
        continue
      }
      if (fromStats.isDirectory() !== toStats.isDirectory()) {
        mismatched.push(relativePath)
        continue
      }
      // Directories carry no bytes of their own; their contents are separate
      // paths in this same list.
      if (fromStats.isDirectory()) continue

      // Content, not size. This is the gate on rmSync, and the invariant it
      // enforces is "every byte of the source is recoverable from the
      // destination" — which equal sizes do not establish. A session that
      // rewrote a file in place during the copy, at the same length, passes a
      // size check here AND passes the drift check below, which is also
      // size-keyed: the two would agree on a file whose bytes were never
      // copied, and the source would be deleted. Two same-length
      // `settings.json` are the realistic case, not a contrived one.
      if (!sameContent(from, fromStats, to, toStats)) {
        mismatched.push(relativePath)
      }
    }

    if (missing.length > 0) {
      const message = `Refusing to remove ${source}: ${summarize('did not arrive', missing)} in ${destination}. ${source} has been kept.`
      announce(message)
      logError(new Error(message))
      return
    }

    if (mismatched.length > 0) {
      const message = `Refusing to remove ${source}: ${summarize('differ at', mismatched)} in ${destination}. ${source} has been kept.`
      announce(message)
      logError(new Error(message))
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
    const changed = [...sourceBefore.entries()]
      .filter(([relativePath, signature]) => {
        const now = sourceAfter.get(relativePath)
        return now !== undefined && now !== signature
      })
      .map(([relativePath]) => relativePath)

    if (appeared.length > 0 || disappeared.length > 0 || changed.length > 0) {
      const changes = [
        summarize('appeared', appeared),
        summarize('disappeared', disappeared),
        summarize('changed', changed),
      ]
        .filter(Boolean)
        .join('; ')
      const message = `Refusing to remove ${source}: it changed while migrating (${changes}). ${source} has been kept.`
      announce(message)
      logError(new Error(message))
      return
    }

    rmSync(source, { recursive: true, force: true })

    // Said out loud for the same reason as the sidecars: this is the one run
    // that could ever mention them. They were not copied and are now gone, and
    // a user who put something deliberate there deserves to be told rather than
    // to discover it missing.
    if (dropped.size > 0) {
      announce(
        `Not copied out of ${source} — ${summarize('sockets, pipes and device nodes are runtime state, not data', [...dropped.values()])}.`,
      )
    }

    // The sidecars are inert and nothing else will ever mention them. Said
    // once, on the single run that creates them, because `source` is gone
    // afterwards and this function never runs again.
    if (preserved.size > 0) {
      announce(
        `Moved ${source} into ${destination}. ${preserved.size} file${preserved.size === 1 ? '' : 's'} already existed there with different contents; ${destination}'s copy was kept and ${summarize('yours was saved alongside it', [...preserved.keys()].map(name => `${name}${PRESERVED_SUFFIX}`))}.`,
      )
    }
  } catch (error) {
    // stderr as well, like every other failure path here. This one is the most
    // important to say out loud, not the least: it catches the unanticipated
    // cases (a permissions error, a full disk, an IO fault), it repeats on every
    // launch, and `logError` alone only reaches the console under HARD_FAIL.
    // Silence here is a migration that never happens and never explains itself.
    const detail = error instanceof Error ? error.message : String(error)
    const message = `Failed to migrate ${source} to ${destination}: ${detail}. ${source} has been kept.`
    announce(message)
    logError(new Error(message, { cause: error }))
  }
}
