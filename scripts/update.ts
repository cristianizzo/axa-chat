import { execFileSync } from 'node:child_process'
import {
  INSTALL_MARKER,
  type InstallMarker,
  readInstallMarker,
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

async function main(): Promise<void> {
  const cwd = process.cwd()

  // The marker is checked before git, and identifies this exact directory as a
  // tarball install. Requiring it is what makes the extract below safe: it is
  // the only positive proof that `cwd` is a source root we own, so a stray
  // invocation from some other directory errors out instead of unpacking a
  // tarball over whatever happens to be there.
  const marker = readInstallMarker(cwd)
  if (marker) {
    try {
      await updateFromTarball(cwd, marker)
    } catch (e) {
      // Stop the `update` script rather than rebuilding a stale tree: the user
      // asked to update, and silently building the old source would look like
      // the update worked.
      console.error(`Could not refresh the source tree: ${(e as Error).message}`)
      process.exitCode = 1
    }
    return
  }

  // No marker, so this must be a checkout. Ask git rather than looking for a
  // `.git` entry: git commands work from anywhere inside a work tree, but
  // `.git` only exists at its root, so a directory test would misread a
  // subdirectory as "not a checkout".
  if (resolveOrNull(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    console.error(
      `${cwd} is neither a git checkout nor a tarball install (no .git, no ${INSTALL_MARKER}) — ` +
        'cannot update. Run this from your axa-chat source directory.',
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

  // Diverged: rebase local commits on top of upstream, stashing uncommitted
  // changes so they're not lost. If the rebase fails for any reason, abort to
  // restore the original branch and let the user reconcile their work themselves.
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

await main()
