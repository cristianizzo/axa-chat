import { execFileSync } from 'node:child_process'

/**
 * Self-update helper for the `update` script.
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
 *     on top of upstream — aborting cleanly on conflict so the working tree and
 *     branch are never left in a broken state.
 *
 * Either way it returns 0 (fetch never errors out the update) and hands off to
 * `bun install` and `bun run build:dev` in the `update` script.
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
  const v = git(args)
  return v ? v : null
}

function main(): void {
  // `rev-parse --abbrev-ref HEAD` returns "HEAD" when detached (not empty).
  // In that unusual state there's no branch whose upstream we can reconcile,
  // so skip the pull.
  const branch = resolveOrNull(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') {
    console.error('Not on a branch (detached HEAD) — skipping pull; can still reinstall + rebuild.')
    return
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
  const aheadStr = git(['rev-list', '--count', `${upstream}..HEAD`], { allowFailure: true })
  const behindStr = git(['rev-list', '--count', `HEAD..${upstream}`], { allowFailure: true })
  const ahead = Number(aheadStr || 0)
  const behind = Number(behindStr || 0)

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
  // changes so they're not lost. On conflict, abort to restore the original
  // branch and let the user reconcile their work themselves.
  console.log(`Diverged from ${upstream} — rebasing local commits…`)
  try {
    execFileSync('git', ['rebase', '--autostash', upstream], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    // Best-effort abort: if the rebase never created a state (e.g. refused
    // before starting), there is nothing to abort — ignore any failure here so
    // the conflict guidance below is always printed.
    try {
      git(['rebase', '--abort'])
    } catch {
      /* nothing to abort */
    }
    const msg =
      (e as { stderr?: string }).stderr?.toString() || (e as { message?: string }).message || ''
    console.error(
      `Rebase on ${upstream} hit a conflict and was aborted. Your local commits and ` +
        `working tree are untouched — resolve the conflict manually before updating again.\n${msg.slice(-500)}`,
    )
    process.exitCode = 1
  }
}

main()
