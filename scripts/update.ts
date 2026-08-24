import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  emitProgress,
  findInstallRoot,
  INSTALL_MARKER,
  type InstallMarker,
  resolveLatestCommit,
  syncFromTarball,
} from './source.js'

/**
 * Self-update helper for the `update` script.
 *
 * Installs without git have no checkout to pull from, so those trees are
 * refreshed from a GitHub source tarball instead (see `scripts/source.ts`);
 * they are recognised by the marker file the installer leaves behind.
 * Everything below applies to the git path.
 *
 * `git pull` refuses to proceed on a divergent branch ("Need to specify how to
 * reconcile divergent branches", exit 128) and a plain `--rebase` can leave the
 * repo half-rebased on a conflict. This script fetches upstream and reconciles
 * explicitly:
 *
 *   - skip when there is nothing new upstream (local up to date or ahead-only —
 *     rebasing an ahead-only branch would just churn commit SHAs),
 *   - fast-forward when the local branch is behind upstream and has no local
 *     commits of its own (the normal case),
 *   - rebase with --autostash when local has diverged, so local commits survive
 *     on top of upstream — aborting cleanly on any rebase failure so the working
 *     tree and branch are never left in a broken state.
 *
 * Exit behavior: returns 0 on the skip, fast-forward, and successful rebase
 * paths; sets exitCode 1 if a rebase failed and was aborted, if a tarball
 * refresh could not complete, or if the directory is neither kind of install
 * (so the caller stops instead of rebuilding a stale tree and reporting
 * success). Note a
 * hard failure (e.g. `git fetch` failing, or being outside a git repo where the
 * early checks throw) will still surface an error to the `update` script, which
 * then stops rather than proceeding to `bun install`.
 */

function git(args: string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    if (opts.allowFailure) return ''
    throw e
  }
}

function resolveOrNull(args: string[]): string | null {
  const v = git(args, { allowFailure: true })
  return v ? v : null
}

/**
 * Refresh a tarball install in place. Skips the download when the recorded
 * commit already matches upstream, so a no-op update costs one API call.
 */
async function updateFromTarball(dir: string, marker: InstallMarker): Promise<void> {
  const { repo, ref } = marker

  const latest = await resolveLatestCommit(repo, ref)
  if (marker.commit === latest) {
    console.log(`Already on the latest ${repo}@${ref} (${latest.slice(0, 8)}).`)
    return
  }

  console.log(
    `Updating source from ${repo}@${ref} (${marker.commit.slice(0, 8)} → ${latest.slice(0, 8)})…`,
  )
  await syncFromTarball(dir, repo, ref, latest)
}

/**
 * Refuse to start while an axa session holds the update lock.
 *
 * The lock itself lives in `src/utils/sourceUpdate.ts`, over `proper-lockfile`,
 * and covers a whole background update: the pull, `bun install`, and the
 * compile. This script is only the first of those three — the other two are
 * separate commands in the `update` npm script — so it cannot hold the lock on
 * their behalf, and taking one here would be given back too early to mean
 * anything. Reading it is still worth doing: a manual `bun run update` on top
 * of a running background one has two `bun install`s writing one
 * `node_modules`, and this catches the ordering that actually happens, where
 * the background update was already going.
 *
 * Checked without `proper-lockfile` on purpose. A compiled install has no
 * `node_modules` between updates — the previous update deletes it — so
 * anything this script imports has to be a Node builtin. The lock is a
 * directory whose mtime the holder refreshes, which is enough to read directly.
 */
const LOCK_STALE_MS = 30 * 60 * 1000

function updateLockHeldBy(dir: string): number | null {
  // Set by the axa process that spawned us, which is holding the lock so that
  // this script can run under it. Refusing then would be refusing over our own
  // parent, and no update would ever run again.
  if (process.env.AXA_UPDATE_LOCK_HELD) return null
  try {
    const { mtimeMs } = statSync(join(dir, '.axa-update.json.lock'))
    const age = Date.now() - mtimeMs
    // Past the stale window the holder is gone and never cleaned up; a real one
    // would have refreshed the mtime long before now.
    return age < LOCK_STALE_MS ? age : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd()

  const heldFor = updateLockHeldBy(cwd)
  if (heldFor !== null) {
    console.error(
      `An axa session is updating this source tree (lock held for ${Math.round(heldFor / 1000)}s). ` +
        'Running a second update would have two `bun install`s writing one node_modules. ' +
        'Wait for it to finish, or use /update inside axa, which shares the lock.',
    )
    process.exitCode = 1
    return
  }

  // The marker is looked for before git, and identifies a directory as a
  // tarball install. Requiring it is what makes the extract below safe: it is
  // the only positive proof of a source root we own, so a stray invocation from
  // an unrelated directory errors out instead of unpacking a tarball over
  // whatever happens to be there.
  //
  // A checkout is never refreshed this way, even if it carries a tarball
  // marker. The marker is gitignored and so invisible to every guard that
  // watches the tree for changes, and taking this path on the strength of one
  // would swap a `git pull` from the checkout's own remote for an extract of
  // whatever repository the file happens to name.
  const install = findInstallRoot(cwd)
  if (install && !existsSync(join(install.dir, '.git'))) {
    if (install.dir !== cwd) console.log(`Updating the install at ${install.dir}…`)
    try {
      await updateFromTarball(install.dir, install.marker)
    } catch (e) {
      // Stop the `update` script rather than rebuilding a stale tree: the user
      // asked to update, and silently building the old source would look like
      // the update worked.
      console.error(`Could not refresh the source tree: ${(e as Error).message}`)
      process.exitCode = 1
    }
    return
  }

  // No tarball marker, so this can only be a checkout. Distinguish "git is missing"
  // from "this is not a checkout": without git the rev-parse below fails the
  // same way an unrelated directory does, and blaming the directory would send
  // someone looking in entirely the wrong place.
  if (!git(['--version'], { allowFailure: true })) {
    console.error(
      `git is not installed, and ${cwd} is not a tarball install either (no ${INSTALL_MARKER} ` +
        'here or in any parent) — cannot update. Install git, or reinstall with install.sh to ' +
        'get a tarball install that updates without it.',
    )
    process.exitCode = 1
    return
  }

  // Ask git rather than looking for a `.git` entry: git commands work from
  // anywhere inside a work tree, but `.git` only exists at its root, so a
  // directory test would misread a subdirectory as "not a checkout".
  if (resolveOrNull(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    console.error(
      `${cwd} is not a usable git checkout, and is not a tarball install either — cannot ` +
        `update. Run this from your axa-chat source directory. (A tree with a .git is always ` +
        `updated through git; a ${INSTALL_MARKER} in one is ignored.)`,
    )
    process.exitCode = 1
    return
  }

  // `rev-parse --abbrev-ref HEAD` returns "HEAD" when detached (not empty).
  // In that unusual state there's no branch whose upstream we can reconcile,
  // so skip the pull.
  const branch = resolveOrNull(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    console.error('Not on a branch (detached HEAD) — skipping pull; can still reinstall + rebuild.')
    return
  }

  // Older installers cloned with `--depth 1`. A shallow clone has no merge base
  // with upstream, so the ahead/behind counts below are meaningless and a rebase
  // cannot replay local commits — deepen once and the repo behaves normally from
  // then on. Best-effort: a non-shallow repo makes this a no-op.
  if (git(['rev-parse', '--is-shallow-repository'], { allowFailure: true }) === 'true') {
    console.log('Shallow clone detected — fetching full history…')
    git(['fetch', '--unshallow'], { allowFailure: true })
  }

  git(['fetch'])

  // Upstream ref may be local (branch.upstream) or the default remote branch.
  const upstream = resolveOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstream) {
    console.error(`No upstream configured for ${branch} — skipping pull; can still reinstall + rebuild.`)
    return
  }

  // `upstream..HEAD` counts commits on HEAD not on upstream = how far ahead.
  // `HEAD..upstream` counts commits on upstream not on HEAD = how far behind.
  // An empty result means `rev-list` failed; treat that as "can't reconcile"
  // and skip rather than guessing the branch is up to date.
  const aheadStr = git(['rev-list', '--count', `${upstream}..HEAD`], { allowFailure: true })
  const behindStr = git(['rev-list', '--count', `HEAD..${upstream}`], { allowFailure: true })
  if (aheadStr === '' || behindStr === '') {
    console.error(`Could not compare HEAD with ${upstream} — skipping pull; can still reinstall + rebuild.`)
    return
  }
  const ahead = Number(aheadStr)
  const behind = Number(behindStr)

  if (behind === 0) {
    // Nothing new upstream: either already up to date or ahead-only. Rebasing
    // an ahead-only branch would rewrite local commit SHAs unnecessarily, so
    // leave it alone.
    console.log(`Already on the latest ${upstream}.`)
    return
  }

  if (ahead === 0) {
    // Only behind upstream after the fetch — fast-forward ahead.
    console.log(`Fast-forwarding ${branch} to ${upstream}…`)
    git(['merge', '--ff-only', upstream])
    return
  }

  // Diverged. An unattended run stops here: a rebase rewrites the user's own
  // commits, and on a conflict there is nobody watching to resolve it. The
  // abort path below would recover the tree, but the update would then fail
  // once an hour forever with no explanation the user ever sees.
  if (process.env.AXA_UPDATE_FF_ONLY) {
    console.error(
      `Diverged from ${upstream} (${ahead} local commit(s), ${behind} upstream) — refusing to ` +
        'rebase during a background update. Run `bun run update` yourself to reconcile.',
    )
    process.exitCode = 1
    return
  }

  // Rebase local commits on top of upstream, stashing uncommitted changes so
  // they're not lost. If the rebase fails for any reason, abort to restore the
  // original branch and let the user reconcile their work themselves.
  console.log(`Diverged from ${upstream} — rebasing local commits…`)
  try {
    execFileSync('git', ['rebase', '--autostash', upstream], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    // Best-effort abort: if the rebase never created a state (e.g. refused
    // before starting), there is nothing to abort — ignore any failure here so
    // the guidance below is always printed.
    try {
      git(['rebase', '--abort'])
    } catch {
      /* nothing to abort */
    }
    const msg =
      (e as { stderr?: string }).stderr?.toString() || (e as { message?: string }).message || ''
    console.error(
      `Rebase on ${upstream} failed and was aborted. Your local commits and working ` +
        `tree are untouched — see the git output below (a merge conflict is the most ` +
        `common cause) and resolve it before updating again.\n${msg.slice(-500)}`,
    )
    process.exitCode = 1
  }
}

// Bracket every exit path so a watching parent never stalls at the value the
// last chunk left behind. The tarball path reports real percentages in
// between; the git path has no equivalent hook, so it just jumps 0 → 100.
emitProgress('download', 0)
try {
  await main()
} finally {
  emitProgress('download', 100)
}
