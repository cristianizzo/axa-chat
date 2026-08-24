import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createStore } from '../state/store.js'
import { isInBundledMode } from './bundledMode.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { lock } from './lockfile.js'
import { logError } from './log.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'

/**
 * Background updates for source installs.
 *
 * axa is distributed as a source tree that compiles to a standalone binary, so
 * there is no package registry to pull a new version from — the unit of update
 * is a commit. This runs in two phases:
 *
 *   1. download + install deps + build, into `cli-dev.next` beside the live
 *      binary. Slow (minutes) but harmless: the compiled binary has its own
 *      copy of everything it executes, so rewriting the source under it changes
 *      nothing about the session already running.
 *   2. swap, by renaming the staged binary over the live one. rename(2) is
 *      atomic and the running process keeps its own inode, so this is safe to
 *      do mid-session; the new build is picked up on the next start.
 *
 * Building straight to the live path instead would corrupt the running binary:
 * `bun build --outfile` truncates its target in place.
 */

const pexec = promisify(execFile)

/** Written at the source root by `install.sh`. See `scripts/source.ts`. */
const INSTALL_MARKER = '.axa-install.json'
const DEFAULT_REPO_SLUG = 'cristianizzo/axa-chat'
const DEFAULT_REF = 'main'

/**
 * The binary `install.sh` builds and symlinks `axa` to, and the staged path
 * that `bun run update:staged` writes beside it.
 *
 * Both names are duplicated in `package.json`, which the build actually obeys;
 * nothing checks that the two agree, so changing either name in one place only
 * means every update fails with "was not produced by bun run update:staged".
 *
 * Both package scripts compile to `cli-dev.next.tmp` and rename from there,
 * never straight to their destination: `bun build --outfile` truncates its
 * target in place, so a build interrupted at `cli-dev.next` would leave a
 * truncated file that still looks staged and gets promoted to the live binary,
 * and one interrupted at `cli-dev` would destroy the binary outright.
 */
const LIVE_BINARY = 'cli-dev'
const STAGED_BINARY = 'cli-dev.next'

/** Duplicated from `scripts/source.ts`, which is not part of the CLI bundle. */
const PROGRESS_PREFIX = '##axa-update '

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Shorter window used when the tree holds a commit the live binary was not
 * built from — the update pulled, then the build was killed when the session
 * quit, which is the normal way for one to end. There is nothing to check for
 * in that state, only a rebuild owed, so waiting out the full day would leave
 * the source and the binary disagreeing for it.
 */
const REBUILD_RETRY_INTERVAL_MS = 60 * 60 * 1000

/**
 * Retries at the short window before falling back to the daily one. Each is a
 * `bun install` and a full compile, and the two ways one fails to land look the
 * same from here — a session too short to finish a build, and a build that
 * cannot succeed at all (no disk, an OOM-killed install, a broken toolchain).
 * Without a cap the second retries hourly, forever, reporting only to the log.
 */
const MAX_REBUILD_ATTEMPTS = 3
/** Cap on the two remote lookups, both of which run while holding the lock. */
const NETWORK_TIMEOUT_MS = 20 * 1000
/**
 * Cap on the local probes (`git ...`, `bun --version`). These are expected to
 * return in milliseconds, but they run while holding the lock and inside the
 * awaited housekeeping chain, so one wedged process must not stall either.
 */
const PROBE_TIMEOUT_MS = 10 * 1000
/** Generous: a cold update reinstalls node_modules and compiles from scratch. */
const LOCK_STALE_MS = 30 * 60 * 1000

export type UpdateStage = 'download' | 'install' | 'build'

export type UpdateProgress =
  | { status: 'idle' }
  | { status: 'running'; stage: UpdateStage; percent: number; detail?: string }
  | { status: 'ready'; sha: string }

/**
 * Share of the overall bar each stage gets, weighted by how long each actually
 * takes: the source download is small, `bun install` dominates, and the compile
 * is comparatively quick. Only the download reports sub-progress, so for most
 * of the run the bar sits at the boundary the last stage change put it at and
 * the byte counter and spinner carry liveness.
 */
const STAGE_RANGE: Record<UpdateStage, { start: number; span: number }> = {
  download: { start: 0, span: 15 },
  install: { start: 15, span: 75 },
  build: { start: 90, span: 10 },
}

const progressStore = createStore<UpdateProgress>({ status: 'idle' })

export const subscribeUpdateProgress = progressStore.subscribe
export const getUpdateProgress = progressStore.getState

/** Overall completion, for a single bar spanning all three stages. */
export function overallPercent(stage: UpdateStage, percent: number): number {
  const { start, span } = STAGE_RANGE[stage]
  return Math.round(start + (Math.max(0, Math.min(100, percent)) / 100) * span)
}

export function clearUpdateProgress(): void {
  progressStore.setState(() => ({ status: 'idle' }))
}

function setRunning(stage: UpdateStage, percent: number, detail?: string): void {
  progressStore.setState(prev =>
    prev.status === 'running' &&
    prev.stage === stage &&
    prev.percent === percent &&
    prev.detail === detail
      ? prev
      : { status: 'running', stage, percent, detail },
  )
}

// ---------------------------------------------------------------------------
// Source tree discovery
// ---------------------------------------------------------------------------

function markerCommit(dir: string): string {
  const marker = readMarker(dir)
  return marker ? marker.commit : ''
}

type InstallMarker = { source: 'tarball' | 'git'; repo: string; ref: string; commit: string }

// `owner/name` and a branch or tag name, matched against the characters GitHub
// permits. Both are interpolated into a GitHub URL, and `..` is excluded on top
// because the allowlists admit dots and a `..` segment would walk the URL path.
// Kept identical to `scripts/source.ts`, so a marker one reader accepts is not
// silently rejected by the other.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
const REF_PATTERN = /^[\w./-]+$/

function isSafeUrlValue(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !value.includes('..')
}

/**
 * Read the install marker, or null when absent or not one of ours. `source` is
 * required so an unrelated JSON file that happens to carry a `commit` cannot
 * pass as a marker.
 *
 * Wider than `readInstallMarker` in `scripts/source.ts`, deliberately: that one
 * gates unpacking a tarball over a directory and so accepts only `tarball`,
 * while here the marker's job is to say "install.sh put this tree here", which
 * is equally true of a clone.
 */
function readMarker(dir: string): InstallMarker | null {
  try {
    const { source, repo, ref, commit } = JSON.parse(
      readFileSync(join(dir, INSTALL_MARKER), 'utf8'),
    ) as Record<string, unknown>
    if (source !== 'tarball' && source !== 'git') return null
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null

    // Absent is fine — the defaults are what the installer writes — but
    // present-and-invalid means the file is not one of ours, so reject rather
    // than silently substitute.
    let repoSlug = DEFAULT_REPO_SLUG
    if (repo !== undefined) {
      if (typeof repo !== 'string' || !isSafeUrlValue(repo, REPO_PATTERN)) return null
      repoSlug = repo
    }
    let refName = DEFAULT_REF
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !isSafeUrlValue(ref, REF_PATTERN)) return null
      refName = ref
    }
    return { source, repo: repoSlug, ref: refName, commit }
  } catch {
    return null
  }
}

/**
 * Whether `dir` is an axa-chat source root.
 *
 * Tested by files specific to this project, not by `package.json` plus a `.git`
 * — that describes most repositories on the machine, and `/update` runs
 * `bun run update:staged` in whatever this returns, which would mean executing
 * a script defined by someone else's package.json.
 *
 * Stricter than `looks_like_axa_source` in install.sh, which accepts a tree
 * carrying the marker *or* these files: this one requires all three, because
 * the marker is attacker-writable and is checked separately.
 */
function isRepoRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'scripts', 'build.ts')) &&
    existsSync(join(dir, 'src', 'entrypoints', 'cli.tsx'))
  )
}

/** Walk up from `start` until a source root or the filesystem root. */
function walkUpToRepoRoot(start: string): string | null {
  let dir = start
  while (dir) {
    if (isRepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Locate the axa-chat source tree. In a compiled binary `process.execPath` is
 * the axa binary, which sits at the source root next to package.json (true for
 * the dev checkout and for installer-based installs under ~/axa-chat, whether
 * cloned with git or unpacked from a tarball).
 */
export function findRepoDir(): string | null {
  try {
    const binary = isInBundledMode() ? realpathSync(process.execPath) : (process.argv[1] ?? '')
    if (binary) {
      const root = walkUpToRepoRoot(dirname(binary))
      if (root) return root
    }
  } catch {
    // realpathSync can throw on a dangling symlink — fall through to fallbacks.
  }

  // The installer's directory exactly, with no walk up: this is a guess at
  // where an install lives, not a path we were launched from, and a parent of
  // it is $HOME. A home directory that happens to hold a package.json, a
  // scripts/build.ts and a src/entrypoints/cli.tsx would otherwise nominate
  // itself, and `/update` runs `bun run update:staged` in whatever this returns.
  const installed = process.env.HOME ? join(process.env.HOME, 'axa-chat') : ''
  if (installed && isRepoRoot(installed)) return installed

  // cwd only when running from source, where the tree we are in is by
  // definition the one to update. For a compiled binary the cwd is the user's
  // project, which is not ours to pull or rebuild.
  return isInBundledMode() ? null : walkUpToRepoRoot(process.cwd())
}

/** Find a runnable `bun` — PATH first, then the standard install locations. */
export async function findBun(): Promise<string> {
  const candidates = ['bun']
  if (process.env.HOME) candidates.push(join(process.env.HOME, '.bun/bin/bun'))
  candidates.push('/opt/homebrew/bin/bun', '/usr/local/bin/bun')
  for (const bun of candidates) {
    try {
      await pexec(bun, ['--version'], { timeout: PROBE_TIMEOUT_MS })
      return bun
    } catch {
      /* not here */
    }
  }
  throw new Error(
    'bun was not found on PATH or in ~/.bun/bin. Install it from https://bun.sh and try again.',
  )
}

/**
 * The update scripts call `bun` by bare name in a subshell, so bun's own
 * directory must be on the child's PATH — axa's inherited PATH may not include
 * it (e.g. ~/.bun/bin). Uses the existing PATH key's casing (Windows: `Path`).
 */
export function withBunOnPath(bun: string): NodeJS.ProcessEnv {
  const bunDir = dirname(bun)
  if (!bunDir || bunDir === '.') return { ...process.env }
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  return {
    ...process.env,
    [pathKey]: `${bunDir}${pathDelimiter}${process.env[pathKey] ?? ''}`,
  }
}

/**
 * Run a git command, returning its trimmed stdout or null when it fails.
 *
 * Callers that decide whether it is safe to touch a tree must use this rather
 * than `gitLine`: `git status --porcelain` prints nothing for a clean tree, so
 * collapsing failure to `''` would read "git is broken" as "clean".
 */
async function tryGit(
  repoDir: string,
  args: string[],
  timeout: number = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', repoDir, ...args], { timeout })
    return stdout.trim()
  } catch {
    return null
  }
}

/** As `tryGit`, with failure flattened to an empty string. */
export async function gitLine(repoDir: string, args: string[]): Promise<string> {
  return (await tryGit(repoDir, args)) ?? ''
}

/**
 * Current revision, from git when `repoDir` is itself a checkout and from the
 * marker otherwise.
 *
 * The `.git` test matters: git answers from anywhere inside a work tree, so a
 * tarball install unpacked under one — `$HOME` being a checkout is enough —
 * would otherwise be stamped with an unrelated repository's HEAD, and rebuild
 * itself every day chasing a commit that has nothing to do with it.
 */
export async function currentRevision(repoDir: string): Promise<string> {
  return (await revision(repoDir, '--short')).slice(0, 7)
}

async function currentFullSha(repoDir: string): Promise<string> {
  return revision(repoDir)
}

async function revision(repoDir: string, ...flags: string[]): Promise<string> {
  if (existsSync(join(repoDir, '.git'))) {
    const sha = await gitLine(repoDir, ['rev-parse', ...flags, 'HEAD'])
    if (sha) return sha
  }
  return markerCommit(repoDir)
}

/**
 * Latest upstream commit, without mutating the tree. Tarball installs have no
 * remote to ask, so they go through the GitHub API; checkouts use `ls-remote`,
 * which reads the remote's refs without downloading objects.
 */
async function latestUpstreamSha(repoDir: string): Promise<string | null> {
  // A checkout is asked directly even when a marker is present: install.sh
  // writes one on the git path too, and the checkout's own branch is the
  // authority on what it will pull, where the marker's `ref` is only what the
  // installer cloned at.
  if (existsSync(join(repoDir, '.git'))) {
    const branch = await tryGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') return null

    // The branch's configured upstream, not `origin/<branch>`. `scripts/update.ts`
    // fast-forwards to `@{upstream}`, so a branch tracking anything else would
    // be compared against a commit the pull is never going to land on: the
    // ancestry test would never match and the tree would reinstall and
    // recompile every day chasing it.
    const remote = await tryGit(repoDir, ['config', '--get', `branch.${branch}.remote`])
    const merge = await tryGit(repoDir, ['config', '--get', `branch.${branch}.merge`])
    if (!remote || !merge) return null

    // Bounded: this runs under the lock, and a blackholed network would
    // otherwise hold it until the stale window expires.
    const line = await tryGit(repoDir, ['ls-remote', remote, merge], NETWORK_TIMEOUT_MS)
    const sha = line?.split(/\s/)[0] ?? ''
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  }

  const marker = readMarker(repoDir)
  return marker ? resolveLatestCommit(marker.repo, marker.ref) : null
}

/**
 * Whether the tree already contains `latest`. An equality test is not enough:
 * `scripts/update.ts` skips the pull when HEAD is not behind its upstream, so a
 * tree that is level with or ahead of its upstream would otherwise look
 * perpetually out of date and rebuild itself every single day.
 */
async function isAlreadyApplied(repoDir: string, latest: string, local: string): Promise<boolean> {
  if (latest === local) return true
  if (!existsSync(join(repoDir, '.git'))) return false
  return isAncestor(repoDir, latest, 'HEAD')
}

/**
 * `git merge-base --is-ancestor` answers by exit status and prints nothing, so
 * a non-null return (an empty string) is the yes. A commit git does not have
 * makes it error out, which reads as false and so fails closed.
 */
async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await tryGit(repoDir, ['merge-base', '--is-ancestor', ancestor, descendant])) !== null
}

/**
 * Resolve `ref` to a commit SHA over the GitHub API. The `vnd.github.sha` media
 * type returns the bare SHA as text/plain. Mirrors `scripts/source.ts`.
 */
async function resolveLatestCommit(repo: string, ref: string): Promise<string | null> {
  const path = `${repo.split('/').map(encodeURIComponent).join('/')}/commits/${encodeURIComponent(ref)}`
  try {
    const res = await fetch(`https://api.github.com/repos/${path}`, {
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'axa-chat-updater' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const sha = (await res.text()).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    // Offline, DNS down, rate limited, timed out. Indistinguishable from "no
    // newer commit" as far as this run is concerned, and not worth reporting:
    // the check runs on every idle period, so a laptop off the network would
    // otherwise file the same error all day.
    return null
  }
}

// ---------------------------------------------------------------------------
// Persisted check state
// ---------------------------------------------------------------------------

type UpdateState = {
  lastCheckAt?: number
  /**
   * Commit the live binary was last built from, which is not the same as the
   * tree's revision: `bun run update:staged` pulls before it builds, so a crash
   * or a shutdown in between leaves a tree that is already at `latest` with a
   * binary that is not. Comparing against this instead of the tree means such a
   * run is retried rather than mistaken for up to date forever.
   *
   * Recorded as the tree's revision at the moment of the swap, which is exact
   * because the two always move together: the same `update:staged` run that
   * pulls the tree is the one that produces the binary swapped in, and the lock
   * keeps a second run from moving the tree in between.
   */
  builtSha?: string
  /**
   * Consecutive builds started and never landed — killed at exit, or failed.
   * Counts up because it is written before the build and only cleared by a
   * swap, so a run that never comes back is counted the same as one that
   * returns an error.
   */
  rebuildAttempts?: number
}

/**
 * Kept in the source tree, not the config dir: the tree is the resource being
 * protected, and this file doubles as the lock target. Two sessions with
 * different CLAUDE_CONFIG_DIRs updating one tree must contend for the same
 * lock, and two trees sharing one config dir must not share a `builtSha`.
 *
 * Gitignored, so it cannot dirty `git status` and deadlock the safety check.
 */
function stateFilePath(repoDir: string): string {
  return join(repoDir, '.axa-update.json')
}

function readState(repoDir: string): UpdateState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFilePath(repoDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { lastCheckAt, builtSha, rebuildAttempts } = parsed as Record<string, unknown>
    return {
      ...(typeof lastCheckAt === 'number' ? { lastCheckAt } : {}),
      ...(typeof builtSha === 'string' && /^[0-9a-f]{40}$/.test(builtSha) ? { builtSha } : {}),
      ...(typeof rebuildAttempts === 'number' && rebuildAttempts >= 0
        ? { rebuildAttempts }
        : {}),
    }
  } catch {
    return {}
  }
}

function writeState(repoDir: string, state: UpdateState): void {
  try {
    writeFileSync(stateFilePath(repoDir), `${JSON.stringify(state, null, 2)}\n`)
  } catch (e) {
    // A read-only tree only costs us the throttle, so the check runs again next
    // start rather than failing the update.
    logError(e)
  }
}

/**
 * Take the update lock, or null when another updater holds it. Shared with
 * `/update` so a foreground run and a background one cannot run `bun install`
 * and a compile over each other in the same tree.
 *
 * Throws on anything that is not contention. Only `ELOCKED` means "someone else
 * is mid-update"; an unwritable tree or a missing directory fails here too, and
 * flattening those to null would have `/update` tell the user to wait for a run
 * that does not exist and is never going to finish.
 *
 * `realpath: false` because the state file may not exist yet on a first run.
 */
export type UpdateLock = {
  release: () => Promise<void>
  /**
   * Fires when the lock stops being ours — proper-lockfile refreshes its mtime
   * while we hold it, so this means the process was suspended past the stale
   * window (a laptop lid) and another session reaped and retook it. Whatever
   * the lock was protecting has to stop.
   */
  lost: AbortSignal
}

export async function acquireUpdateLock(repoDir: string): Promise<UpdateLock | null> {
  const lostController = new AbortController()
  let compromised = false
  let release: () => Promise<void>
  try {
    release = await lock(stateFilePath(repoDir), {
      stale: LOCK_STALE_MS,
      realpath: false,
      // Default is to rethrow, from inside an fs callback — an uncaught exception
      // that would take axa down. A compromised lock is worth a log and a stop,
      // not a crash.
      onCompromised: e => {
        compromised = true
        logError(e)
        lostController.abort()
      },
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOCKED') return null
    throw e
  }

  // axa leaves via `process.exit`, which never settles the pending promise the
  // async release returns, so quitting mid-update would strand the lock
  // directory with a fresh mtime. Every session for the next half hour would
  // then be told an update is already running with nothing running at all —
  // and quitting mid-update is the normal case, since the build only starts
  // after the user has been idle and then takes minutes. Hence a synchronous
  // teardown as well.
  const lockDir = `${stateFilePath(repoDir)}.lock`
  // Identity of the directory we were handed, so the teardown can tell it apart
  // from a replacement. `onCompromised` is the reliable signal but it arrives on
  // a refresh timer, so between a reap and the next tick the flag still reads
  // clean while the directory on disk belongs to somebody else.
  let ino: number | undefined
  try {
    ino = lstatSync(lockDir).ino
  } catch {
    // Nothing to compare against, so the teardown below will leave it alone.
  }
  const onExit = () => {
    // No longer ours: another process may have reaped and retaken it, and
    // removing it then would hand a third one a lock over a live update.
    if (compromised || ino === undefined) return
    try {
      if (lstatSync(lockDir).ino !== ino) return
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      // Exiting anyway; the stale window is the backstop.
    }
  }
  process.once('exit', onExit)

  return {
    lost: lostController.signal,
    release: async () => {
      process.removeListener('exit', onExit)
      // The same reasoning as the exit handler, for the same reason: after a
      // compromise the directory at that path is somebody else's, and
      // proper-lockfile's release removes it by path without rechecking. It
      // has already stopped treating the lock as ours, so there is nothing
      // left here to give back.
      if (compromised) return
      await release()
    },
  }
}

/**
 * Record that the live binary is built from `repoDir`'s current revision, so a
 * background check right after a foreground `/update` sees it as up to date.
 *
 * Clears the retry count too: a build just succeeded here, so whatever the
 * background attempts were failing on is no longer failing.
 */
export async function recordBuiltSha(repoDir: string): Promise<void> {
  const built = await currentFullSha(repoDir)
  if (built) {
    writeState(repoDir, { ...readState(repoDir), builtSha: built, rebuildAttempts: 0 })
  }
}

// ---------------------------------------------------------------------------
// Phase 1: stage a new build
// ---------------------------------------------------------------------------

/** Apply one line of child output, returning what it reported, or null. */
function handleProgressLine(line: string): { stage: UpdateStage; percent: number } | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { stage, percent, detail } = parsed as Record<string, unknown>
  if (stage !== 'download' && stage !== 'install' && stage !== 'build') return null
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null

  // `detail` comes from the child's stdout, and `bun install` and the compile
  // both write there too — a line of theirs that happened to carry the prefix
  // would reach the renderer. Bound it rather than trusting the length.
  setRunning(stage, percent, typeof detail === 'string' ? detail.slice(0, 80) : undefined)

  // Nothing instruments `bun install`, so its span is inferred: it is whatever
  // happens between the download finishing and the build announcing itself.
  if (stage === 'download' && percent >= 100) setRunning('install', 0)
  return { stage, percent }
}

/** Beyond this, the update is assumed wedged (a hung fetch, a stuck install). */
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
/** Cap on a partial line held across chunks, so garbage output cannot grow unbounded. */
const MAX_PENDING_LINE = 64 * 1024

export type StagedUpdateOptions = {
  /** Aborts when the update lock stops being ours; stops the build. */
  lost?: AbortSignal
  /**
   * Refuse to rebase when the branch has diverged from upstream. Set for
   * unattended runs: rebasing rewrites the user's local commits, and if it hits
   * a conflict there is nobody there to resolve it.
   */
  ffOnly?: boolean
}

export function runStagedUpdate(
  repoDir: string,
  bun: string,
  { lost: signal, ffOnly }: StagedUpdateOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Checked before spawning, not just subscribed to: a signal that has
    // already fired never calls a listener added afterwards, and the lock can
    // be lost during the awaits that precede this call.
    if (signal?.aborted) {
      reject(new Error('the update lock was lost before the build started'))
      return
    }

    const child = spawn(bun, ['run', 'update:staged'], {
      cwd: repoDir,
      env: {
        ...withBunOnPath(bun),
        AXA_UPDATE_PROGRESS: '1',
        // This process holds the update lock on the child's behalf, so the
        // child must not refuse on finding one — it would be refusing over us.
        AXA_UPDATE_LOCK_HELD: '1',
        ...(ffOnly ? { AXA_UPDATE_FF_ONLY: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so killing it takes the whole `bun run` tree —
      // otherwise the shell dies and the install or compile under it keeps going.
      detached: true,
    })

    const signalGroup = (sig: NodeJS.Signals) => {
      const { pid } = child
      if (pid === undefined) return
      try {
        process.kill(-pid, sig)
      } catch {
        // Already gone.
      }
    }

    // Whether the child is past `scripts/update.ts`, which reports `download`
    // and hands over at 100. Everything before that point is git (or tar);
    // everything after is `bun install` and the compile.
    let pastSourcePhase = false

    /** SIGKILL after a grace period, since a wedged child may ignore SIGTERM. */
    let escalation: NodeJS.Timeout | undefined
    const kill = () => {
      // One escalation only. The timeout and the lock loss can both fire before
      // the child is reaped, and a second call would overwrite the handle
      // `cleanup` cancels — leaving an orphan to signal a process group that by
      // then belongs to whoever inherited the pid.
      if (escalation) return
      signalGroup('SIGTERM')
      // Held so `cleanup` can cancel it: once the child is gone its pid is free
      // to be reused, and firing this late would signal a stranger's process
      // group instead.
      escalation = setTimeout(() => signalGroup('SIGKILL'), 5000)
      escalation.unref()
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, UPDATE_TIMEOUT_MS)
    timer.unref()

    // The lock stopped being ours mid-build — the machine slept past the stale
    // window and another session reaped it. Stop, rather than let two updates
    // write `node_modules` and the staged binary at once.
    let lockLost = false
    const onLockLost = () => {
      lockLost = true
      kill()
    }
    signal?.addEventListener('abort', onLockLost, { once: true })

    // A staged build left running past exit would keep writing into the tree
    // with nothing left to swap it in, and the lock it was covered by dies with
    // us. One signal only: 'exit' handlers run synchronously on a process that
    // is already leaving, so a deferred escalation would never fire, and
    // `detached` means the child does not get the terminal's SIGHUP either.
    //
    // Which signal depends on where it got to. SIGKILL during the git phase can
    // leave `.git/index.lock` or a half-written ref behind, and from then on
    // every git call in this tree fails — which fails closed, so auto-update
    // would be off for good and `/update` broken, until the user finds the lock
    // file themselves. git tears those down on SIGTERM. After that phase it is
    // `bun install` and the compile, both re-runnable from scratch, so those
    // get the signal that is actually guaranteed to stop them.
    const onExit = () => signalGroup(pastSourcePhase ? 'SIGKILL' : 'SIGTERM')
    process.once('exit', onExit)

    const cleanup = () => {
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      signal?.removeEventListener('abort', onLockLost)
      process.removeListener('exit', onExit)
    }

    // Progress lines can be split across chunks; hold the trailing partial.
    let pending = ''
    // `scripts/update.ts` explains itself on stdout ("git is not installed",
    // "no such ref"), so a tail of it is kept for the failure message — several
    // ways this child fails say why there and exit without touching stderr.
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n')
      pending = (lines.pop() ?? '').slice(-MAX_PENDING_LINE)
      for (const line of lines) {
        const reported = handleProgressLine(line)
        if (!reported) stdout = `${stdout}${line}\n`.slice(-2000)
        else if (reported.stage !== 'download' || reported.percent >= 100) pastSourcePhase = true
      }
    })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000)
    })

    child.on('error', e => {
      cleanup()
      reject(e)
    })
    child.on('close', (code, signal) => {
      cleanup()
      // The child can exit without a trailing newline; that last line still
      // carries the final progress marker.
      if (pending) handleProgressLine(pending)
      if (lockLost) {
        reject(new Error('the update lock was taken by another process; stopped mid-build'))
      } else if (timedOut) {
        reject(new Error(`bun run update:staged timed out after ${UPDATE_TIMEOUT_MS / 60000}min`))
      } else if (code === 0) {
        resolve()
      } else {
        // How it died leads, and the captured output follows. A `bun install`
        // that the OOM killer takes out exits on a signal with an empty or
        // unrelated stderr, so reporting the output alone would describe the
        // wrong failure — or none at all.
        const how = signal ? `killed by ${signal}` : `exited with ${code}`
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(
          new Error(
            output
              ? `bun run update:staged ${how}:\n${output}`
              : `bun run update:staged ${how}`,
          ),
        )
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Phase 2: swap the staged binary in
// ---------------------------------------------------------------------------

/**
 * Move a staged binary over the live one. Atomic, and safe while that binary is
 * running: the process keeps the inode it started from, so it is the next start
 * that picks up the new build.
 *
 * Returns false when there is nothing staged.
 */
export function applyStagedBinary(repoDir: string): boolean {
  const staged = join(repoDir, STAGED_BINARY)
  let stats
  try {
    stats = lstatSync(staged)
  } catch {
    return false
  }
  // Rejected here means it will be rejected identically on every later run, so
  // drop it: the staged file's existence is what makes each new session take
  // the update lock and look, and leaving one behind makes that permanent.
  //
  // Logged, because both callers describe a false return as "the build produced
  // nothing" — the message for the empty case, which is the only one they can
  // tell apart. A discard is the opposite: something was produced and thrown
  // away, and without this the only record of it is gone with the file.
  const discard = (why: string) => {
    logError(new Error(`Discarded ${STAGED_BINARY} in ${repoDir}: ${why}`))
    try {
      rmSync(staged, { recursive: true, force: true })
    } catch {
      // Nothing to fall back on; the next build overwrites it anyway.
    }
    return false
  }

  // lstat, and a real file: rename(2) moves a symlink rather than following it,
  // so a `cli-dev.next` symlink planted in the tree would make the live binary
  // point at something we never built — and axa would exec it on next launch.
  if (!stats.isFile()) return discard('not a regular file')

  // A staged build is applied by a later session than the one that made it, and
  // `bun run build:dev` in the meantime writes the live binary directly. Older
  // wins nothing: promoting it would quietly undo that rebuild.
  //
  // `>=`, not `>`: equal mtimes are no evidence the stage is the later of the
  // two, and on a filesystem with one-second timestamps they are what a manual
  // rebuild right after a staged one looks like. Keeping the live binary is the
  // recoverable way to be wrong — the stage is rebuilt, a discarded rebuild is
  // not.
  const live = join(repoDir, LIVE_BINARY)
  try {
    const liveMtime = lstatSync(live).mtimeMs
    if (liveMtime >= stats.mtimeMs) {
      return discard(
        `${LIVE_BINARY} is not older (${new Date(liveMtime).toISOString()} vs ` +
          `${new Date(stats.mtimeMs).toISOString()})`,
      )
    }
  } catch (e) {
    // Only "there is no live binary" is safe to carry on from. Anything else —
    // a permission error, an I/O error — leaves a live binary that may well be
    // newer, unread, and this is the check that stops it being overwritten.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(e)
      return false
    }
  }

  renameSync(staged, live)
  return true
}

/**
 * Trim build-time deps. The compiled binary is standalone, so node_modules
 * (~400MB) is not needed at runtime, and the next update reinstalls it.
 */
async function trimNodeModules(repoDir: string): Promise<void> {
  // Non-fatal: the update has already landed by this point, and a stale
  // node_modules only costs disk. Logged rather than swallowed, because a
  // failure here is usually a permissions problem worth seeing.
  await rm(join(repoDir, 'node_modules'), { recursive: true, force: true }).catch(logError)
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Whether it is safe to rebuild this tree behind the user's back. A checkout
 * with uncommitted work is somebody's working copy, not an install: the update
 * would rebase over their changes and rebuild their binary without asking.
 */
async function isUnattendedUpdateSafe(repoDir: string): Promise<boolean> {
  // No checkout: nothing to preserve and nothing to ask. The tarball updater
  // overwrites files in place, which is exactly what the install expects.
  if (!existsSync(join(repoDir, '.git'))) return readMarker(repoDir) !== null

  // Every check below fails closed — a null is git erroring out, not a clean
  // tree, and "we could not tell" must never authorise a rebase and rebuild.
  // `--untracked-files` explicitly, because `status.showUntrackedFiles` is a
  // config a user can set to `no` — and then a tree full of untracked work
  // reports clean and this guard waves it through.
  const status = await tryGit(repoDir, ['status', '--porcelain', '--untracked-files=normal'])
  if (status !== '') {
    // A dirty tree is the ordinary answer and stays quiet. `git status` failing
    // outright is not: no git on PATH, a corrupt index, an unreadable objects
    // directory. That disables auto-update permanently and silently, so it is
    // the one branch here worth a report.
    if (status === null) logError(new Error(`git status failed in ${repoDir}`))
    return false
  }

  // Detached HEAD or a branch with no upstream: `git pull` in the updater has
  // nothing well-defined to fast-forward to, so leave the tree alone.
  const branch = await tryGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return false
  const upstream = await tryGit(repoDir, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
  if (!upstream) return false

  // Commits that exist only here. `scripts/update.ts` reconciles with
  // `git rebase --autostash`, which would rewrite them; committed work is not
  // lost the way uncommitted work is, but having it rebased unasked is the same
  // class of surprise this guard exists to prevent.
  const ahead = await tryGit(repoDir, ['rev-list', '--count', '@{upstream}..HEAD'])
  return ahead === '0'
}

/**
 * Whether `repoDir` was put there by `install.sh` rather than cloned by hand.
 *
 * This is the guard that keeps a developer's checkout out of the auto-updater,
 * and it needs positive proof: `bun run build:dev` writes `./cli-dev` at the
 * root of any checkout, so "a cli-dev next to a package.json" describes a
 * working copy just as well as an install. Getting it wrong means pulling over
 * someone's branch and deleting their node_modules.
 *
 * The marker `install.sh` writes is that proof, and it is the only accepted
 * one. Installs made before the installer wrote a marker on the git path stay
 * on manual `/update` until install.sh is run again — the alternative was
 * inferring "this is an install" from the `axa` symlink, which is exactly what
 * a developer working in ~/axa-chat also has.
 */
function isInstallerManaged(repoDir: string): boolean {
  return readMarker(repoDir) !== null
}

/**
 * Resolve the source tree this process was launched from, but only when the
 * running binary is the one `install.sh` produces. Anything else — running from
 * source, a binary built elsewhere, a checkout that is not the one we started
 * from — is left alone.
 */
function autoUpdatableRepoDir(): string | null {
  if (!isInBundledMode()) return null
  let binary: string
  try {
    binary = realpathSync(process.execPath)
  } catch {
    return null
  }
  const repoDir = dirname(binary)
  if (binary !== join(repoDir, LIVE_BINARY)) return null
  if (!isRepoRoot(repoDir)) return null
  return isInstallerManaged(repoDir) ? repoDir : null
}

/**
 * Check for a newer commit and, if there is one, download and build it in the
 * background. Called from background housekeeping; never throws.
 */
export async function maybeUpdateSourceInBackground(): Promise<void> {
  try {
    // The pre-existing opt-out, honoured alongside the new setting.
    // `migrateAutoUpdatesToSettings` turns an old `autoUpdates: false` into
    // this env var, so ignoring it would hand background updates back to the
    // people who had already turned them off.
    //
    // The env var only, not `getAutoUpdaterDisabledReason()`: that also reports
    // disabled for a development build, and every install this runs in is one.
    if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) return
    // Auto-updates are named in what `essential-traffic` suppresses, and this
    // reaches GitHub on every check.
    if (isEssentialTrafficOnly()) return
    if (!getGlobalConfig().autoUpdate) return

    const repoDir = autoUpdatableRepoDir()
    if (!repoDir) return

    // Cheap pre-checks, so the common case does not touch the lock file at all.
    // Both are repeated under the lock, where they are the ones that count.
    //
    // The shorter window here deliberately: telling the two apart needs the
    // tree's revision, and asking git for it is the kind of work this check
    // exists to avoid. Being the looser of the two only costs a session past
    // its day an hourly `git status` and a lock it immediately gives back.
    const staged = existsSync(join(repoDir, STAGED_BINARY))
    const pre = readState(repoDir)
    if (
      !staged &&
      pre.lastCheckAt &&
      Date.now() - pre.lastCheckAt < REBUILD_RETRY_INTERVAL_MS
    ) {
      return
    }
    if (!(await isUnattendedUpdateSafe(repoDir))) return

    // Hold the lock for the whole check-and-build so two axa sessions cannot
    // run `bun install` over each other in the same tree — and so the rename
    // below cannot land while another session is mid-build.
    const lock = await acquireUpdateLock(repoDir)
    // Another session is already on it.
    if (!lock) return

    try {
      // Re-checked under the lock, before anything is touched: the snapshot
      // above was taken before waiting, and the user may have started editing
      // in the meantime.
      if (!(await isUnattendedUpdateSafe(repoDir))) return

      // The lock can be lost across any await in here, not only the build —
      // it goes when the machine is suspended past the stale window and
      // another session reaps it, which can happen mid-`git status` as easily
      // as mid-compile. Checked before each thing that writes.
      if (lock.lost.aborted) return

      // A build staged by an earlier session that was closed before it could
      // swap. Inside the lock: an unlocked rename could pull the binary out
      // from under a build another session is still writing.
      if (applyStagedBinary(repoDir)) {
        const full = await currentFullSha(repoDir)
        if (full) {
          writeState(repoDir, { ...readState(repoDir), builtSha: full, rebuildAttempts: 0 })
        }
        // That earlier session installed node_modules and never got to trim it.
        await trimNodeModules(repoDir)
        progressStore.setState(() => ({ status: 'ready', sha: full.slice(0, 7) || 'unknown' }))
        return
      }

      const state = readState(repoDir)
      const local = await currentFullSha(repoDir)
      if (!local) return

      // Read before the remote lookup, so a throttled run costs no network.
      const attempts = state.rebuildAttempts ?? 0
      const unbuilt = state.builtSha !== undefined && state.builtSha !== local
      const window =
        unbuilt && attempts < MAX_REBUILD_ATTEMPTS
          ? REBUILD_RETRY_INTERVAL_MS
          : CHECK_INTERVAL_MS
      if (state.lastCheckAt && Date.now() - state.lastCheckAt < window) return

      const latest = await latestUpstreamSha(repoDir)
      if (!latest) return

      // First run against an already-current tree: adopt its revision as the
      // built one rather than rebuilding to reach where we already are.
      const builtSha = state.builtSha ?? local

      // Burn the window before building, not after. A failure that repeats —
      // no disk, no network, a broken toolchain — then costs one attempt a
      // window instead of one per idle period.
      writeState(repoDir, { lastCheckAt: Date.now(), builtSha, rebuildAttempts: attempts })
      if (builtSha === local && (await isAlreadyApplied(repoDir, latest, local))) return

      const bun = await findBun()

      // Counted before the build rather than on the way out of a failed one: a
      // build killed when the session quits never comes back to record
      // anything, and it has to cost the same as one that fails outright or the
      // short window above would retry it hourly and forever.
      writeState(repoDir, {
        lastCheckAt: Date.now(),
        builtSha,
        rebuildAttempts: attempts + 1,
      })
      setRunning('download', 0)
      await runStagedUpdate(repoDir, bun, { lost: lock.lost, ffOnly: true })

      // `runStagedUpdate` stops the child on loss, but the loss can also land
      // in the moment between the child closing and this line.
      if (lock.lost.aborted) {
        throw new Error('the update lock was lost before the staged binary could be applied')
      }

      // Only a swap that actually happened is an update. Without a staged
      // binary the build produced nothing, and announcing "restart to use the
      // new build" would send the user to relaunch the same one.
      if (!applyStagedBinary(repoDir)) {
        throw new Error(`${STAGED_BINARY} was not produced by bun run update:staged`)
      }
      // Re-read from the tree rather than trusting `latest`: the pull resolves
      // the branch head itself, which may have moved on since the check.
      const built = (await currentFullSha(repoDir)) || latest
      writeState(repoDir, { lastCheckAt: Date.now(), builtSha: built, rebuildAttempts: 0 })
      await trimNodeModules(repoDir)
      progressStore.setState(() => ({ status: 'ready', sha: built.slice(0, 7) }))
    } finally {
      await lock.release().catch(() => {})
    }
  } catch (e) {
    clearUpdateProgress()
    logError(e)
  }
}
