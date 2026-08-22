import { execFileSync } from 'node:child_process'

/**
 * Self-update helper for the `update` script.
 *
 * `git pull` refuses to proceed on a divergent branch ("Need to specify how to
 * reconcile divergent branches", exit 128) and a plain `--rebase` can leave the
 * repo half-rebased on a conflict. This script fetches upstream and reconciles
 * explicitly:
 *
 *   - fast-forward when the local branch is behind upstream (the normal case),
 *   - rebase with --autostash when local has diverged, so local commits survive
 *     on top of upstream — aborting cleanly on conflict so the working tree and
 *     branch are never left in a broken state,
 *   - skip the pull entirely when already up to date.
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
  // Current branch (empty when detached HEAD). Fall back to a bare fetch.
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

  const behindStr = git(['rev-list', '--count', `${upstream}..HEAD`], { allowFailure: true })
  const aheadStr = git(['rev-list', '--count', `HEAD..${upstream}`], { allowFailure: true })
  const behind = Number(behindStr || 0)
  const ahead = Number(aheadStr || 0)

  if (ahead === 0 && behind === 0) {
    console.log(`Already on the latest ${upstream}.`)
    return
  }

  if (behind === 0) {
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
    git(['rebase', '--abort'])
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
