import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createStore } from '../state/store.js'
import { isInBundledMode } from './bundledMode.js'
import { getGlobalConfig } from './config.js'
import { lock } from './lockfile.js'
import { logError } from './log.js'

/**
 * Background updates for source installs.
 *
 * axa is distributed as a source tree that compiles to a standalone binary, so
 * there is no package registry to pull a new version from — the unit of update
 * is a commit. This runs in two phases:
 *
 *   1. download + install deps + build, into `cli-dev.next` beside the live
 *      binary. Slow (minutes) but harmless: nothing the running process depends
 *      on is touched, because the compiled binary reads nothing from the source
 *      tree at runtime.
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
 * that `bun run update:staged` writes. Auto-update only runs when the process
 * really is that binary, so the hardcoded name in the package script and the
 * file we swap can never refer to different things.
 */
const LIVE_BINARY = 'cli-dev'
const STAGED_BINARY = 'cli-dev.next'

/** Duplicated from `scripts/source.ts`, which is not part of the CLI bundle. */
const PROGRESS_PREFIX = '##axa-update '

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Cap on the two remote lookups, both of which run while holding the lock. */
const NETWORK_TIMEOUT_MS = 20 * 1000
/** Generous: a cold update reinstalls node_modules and compiles from scratch. */
const LOCK_STALE_MS = 30 * 60 * 1000

export type UpdateStage = 'download' | 'install' | 'build'

export type UpdateProgress =
  | { status: 'idle' }
  | { status: 'running'; stage: UpdateStage; percent: number; detail?: string }
  | { status: 'ready'; sha: string }

/**
 * Share of the overall bar each stage gets, weighted by how long each actually
 * takes: the tarball is a few megabytes, `bun install` pulls ~400MB, and the
 * compile is seconds. Only `install` and `build` really move the bar, and
 * neither reports sub-progress, so the bar advances at stage boundaries while
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
 * `bun run update` in whatever this returns, which would mean executing a
 * script defined by someone else's package.json. Mirrors `looks_like_axa_source`
 * in install.sh.
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
  const candidates: string[] = []
  try {
    const binary = isInBundledMode() ? realpathSync(process.execPath) : (process.argv[1] ?? '')
    if (binary) candidates.push(dirname(binary))
  } catch {
    // realpathSync can throw on a dangling symlink — fall through to fallbacks.
  }
  if (process.env.HOME) candidates.push(join(process.env.HOME, 'axa-chat'))
  // cwd only when running from source, where the tree we are in is by
  // definition the one to update. For a compiled binary the cwd is the user's
  // project, which is not ours to pull or rebuild.
  if (!isInBundledMode()) candidates.push(process.cwd())

  for (const dir of candidates) {
    const root = walkUpToRepoRoot(dir)
    if (root) return root
  }
  return null
}

/** Find a runnable `bun` — PATH first, then the standard install locations. */
export async function findBun(): Promise<string> {
  const candidates = ['bun']
  if (process.env.HOME) candidates.push(join(process.env.HOME, '.bun/bin/bun'))
  candidates.push('/opt/homebrew/bin/bun', '/usr/local/bin/bun')
  for (const bun of candidates) {
    try {
      await pexec(bun, ['--version'])
      return bun
    } catch {
      // try next candidate
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
async function tryGit(repoDir: string, args: string[], timeout?: number): Promise<string | null> {
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

/** Current revision, short, from git when there is a checkout and the marker otherwise. */
export async function currentRevision(repoDir: string): Promise<string> {
  return (await gitLine(repoDir, ['rev-parse', '--short', 'HEAD'])) || markerCommit(repoDir).slice(0, 7)
}

async function currentFullSha(repoDir: string): Promise<string> {
  return (await gitLine(repoDir, ['rev-parse', 'HEAD'])) || markerCommit(repoDir)
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
    // Bounded: this runs under the lock, and a blackholed network would
    // otherwise hold it until the stale window expires.
    const line = await tryGit(repoDir, ['ls-remote', 'origin', branch], NETWORK_TIMEOUT_MS)
    const sha = line?.split(/\s/)[0] ?? ''
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  }

  const marker = readMarker(repoDir)
  return marker ? resolveLatestCommit(marker.repo, marker.ref) : null
}

/**
 * Whether the tree already contains `latest`. An equality test is not enough:
 * `scripts/update.ts` skips the pull when HEAD is not behind its upstream, so a
 * tree that is level with or ahead of `origin/<branch>` would otherwise look
 * perpetually out of date and rebuild itself every single day.
 */
async function isAlreadyApplied(repoDir: string, latest: string, local: string): Promise<boolean> {
  if (latest === local) return true
  if (!existsSync(join(repoDir, '.git'))) return false
  return (await tryGit(repoDir, ['merge-base', '--is-ancestor', latest, 'HEAD'])) !== null
}

/**
 * Resolve `ref` to a commit SHA over the GitHub API. The `vnd.github.sha` media
 * type returns the bare SHA as text/plain. Mirrors `scripts/source.ts`.
 */
async function resolveLatestCommit(repo: string, ref: string): Promise<string | null> {
  const path = `${repo.split('/').map(encodeURIComponent).join('/')}/commits/${encodeURIComponent(ref)}`
  const res = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { accept: 'application/vnd.github.sha', 'user-agent': 'axa-chat-updater' },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!res.ok) return null
  const sha = (await res.text()).trim()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
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
   */
  builtSha?: string
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
    const { lastCheckAt, builtSha } = parsed as Record<string, unknown>
    return {
      ...(typeof lastCheckAt === 'number' ? { lastCheckAt } : {}),
      ...(typeof builtSha === 'string' && /^[0-9a-f]{40}$/.test(builtSha) ? { builtSha } : {}),
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
 * `realpath: false` because the state file may not exist yet on a first run.
 */
export async function acquireUpdateLock(repoDir: string): Promise<(() => Promise<void>) | null> {
  return lock(stateFilePath(repoDir), {
    stale: LOCK_STALE_MS,
    realpath: false,
    // Default is to rethrow, from inside an fs callback — an uncaught exception
    // that would take axa down. A compromised lock (the machine slept past the
    // stale window, or another process reaped it) is worth a log, not a crash.
    onCompromised: logError,
  }).catch(() => null)
}

/**
 * Record that the live binary is built from `repoDir`'s current revision, so a
 * background check right after a foreground `/update` sees it as up to date.
 */
export async function recordBuiltSha(repoDir: string): Promise<void> {
  const built = await currentFullSha(repoDir)
  if (built) writeState(repoDir, { ...readState(repoDir), builtSha: built })
}

// ---------------------------------------------------------------------------
// Phase 1: stage a new build
// ---------------------------------------------------------------------------

function handleProgressLine(line: string): void {
  if (!line.startsWith(PROGRESS_PREFIX)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length))
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const { stage, percent, detail } = parsed as Record<string, unknown>
  if (stage !== 'download' && stage !== 'install' && stage !== 'build') return
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return

  // Everything the child writes to stdout is parsed here, `bun install`'s
  // output included, so `detail` is not fully under our control — bound it
  // rather than handing an arbitrary string to the renderer.
  setRunning(stage, percent, typeof detail === 'string' ? detail.slice(0, 80) : undefined)

  // Nothing instruments `bun install`, so its span is inferred: it is whatever
  // happens between the download finishing and the build announcing itself.
  if (stage === 'download' && percent >= 100) setRunning('install', 0)
}

/** Beyond this, the update is assumed wedged (a hung fetch, a stuck install). */
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000
/** Cap on a partial line held across chunks, so garbage output cannot grow unbounded. */
const MAX_PENDING_LINE = 64 * 1024

export function runStagedUpdate(repoDir: string, bun: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bun, ['run', 'update:staged'], {
      cwd: repoDir,
      env: { ...withBunOnPath(bun), AXA_UPDATE_PROGRESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so killing it takes the whole `bun run` tree —
      // otherwise the shell dies and the install or compile under it keeps going.
      detached: true,
    })

    const signalGroup = (sig: NodeJS.Signals) => {
      const { pid } = child
      if (pid === undefined) return
      try {
        // Negative pid: the process group, so the whole `bun run` tree goes.
        process.kill(-pid, sig)
      } catch {
        // Already gone.
      }
    }

    /** SIGKILL after a grace period, since a wedged child may ignore SIGTERM. */
    const kill = () => {
      signalGroup('SIGTERM')
      setTimeout(() => signalGroup('SIGKILL'), 5000).unref()
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, UPDATE_TIMEOUT_MS)
    timer.unref()

    // A staged build left running past exit would keep writing into the tree
    // with nothing left to swap it in, and the lock it was covered by dies with
    // us. SIGKILL directly: 'exit' handlers run synchronously on a process that
    // is already leaving, so a deferred escalation would never fire, and
    // `detached` means the child does not get the terminal's SIGHUP either.
    const onExit = () => signalGroup('SIGKILL')
    process.once('exit', onExit)

    const cleanup = () => {
      clearTimeout(timer)
      process.removeListener('exit', onExit)
    }

    // Progress lines can be split across chunks; hold the trailing partial.
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n')
      pending = (lines.pop() ?? '').slice(-MAX_PENDING_LINE)
      for (const line of lines) handleProgressLine(line)
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
    child.on('close', code => {
      cleanup()
      // The child can exit without a trailing newline; that last line still
      // carries the final progress marker.
      if (pending) handleProgressLine(pending)
      if (timedOut) {
        reject(new Error(`bun run update:staged timed out after ${UPDATE_TIMEOUT_MS / 60000}min`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `bun run update:staged exited with ${code}`))
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
  if (!existsSync(staged)) return false
  renameSync(staged, join(repoDir, LIVE_BINARY))
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
  const status = await tryGit(repoDir, ['status', '--porcelain'])
  if (status !== '') return false

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
    if (!getGlobalConfig().autoUpdate) return

    const repoDir = autoUpdatableRepoDir()
    if (!repoDir) return

    // Cheap pre-checks, so the common case does not touch the lock file at all.
    // Both are repeated under the lock, where they are the ones that count.
    const staged = existsSync(join(repoDir, STAGED_BINARY))
    const pre = readState(repoDir)
    if (!staged && pre.lastCheckAt && Date.now() - pre.lastCheckAt < CHECK_INTERVAL_MS) return
    if (!(await isUnattendedUpdateSafe(repoDir))) return

    // Hold the lock for the whole check-and-build so two axa sessions cannot
    // run `bun install` over each other in the same tree — and so the rename
    // below cannot land while another session is mid-build.
    const release = await acquireUpdateLock(repoDir)
    // Another session is already on it.
    if (!release) return

    try {
      // A build staged by an earlier session that was closed before it could
      // swap. Inside the lock: an unlocked rename could pull the binary out
      // from under a build another session is still writing.
      if (applyStagedBinary(repoDir)) {
        const full = await currentFullSha(repoDir)
        if (full) writeState(repoDir, { ...readState(repoDir), builtSha: full })
        progressStore.setState(() => ({ status: 'ready', sha: full.slice(0, 7) || 'unknown' }))
        return
      }

      const state = readState(repoDir)
      if (state.lastCheckAt && Date.now() - state.lastCheckAt < CHECK_INTERVAL_MS) return

      // Re-checked under the lock: the snapshot above was taken before waiting,
      // and the user may have started editing in the meantime.
      if (!(await isUnattendedUpdateSafe(repoDir))) return

      const [local, latest] = await Promise.all([
        currentFullSha(repoDir),
        latestUpstreamSha(repoDir),
      ])
      if (!latest || !local) return

      // First run against an already-current tree: adopt its revision as the
      // built one rather than rebuilding to reach where we already are.
      const builtSha = state.builtSha ?? local

      // Burn the daily window before building, not after. A failure that
      // repeats — no disk, no network, a broken toolchain — then costs one
      // attempt a day instead of one per idle period.
      writeState(repoDir, { lastCheckAt: Date.now(), builtSha })
      if (builtSha === local && (await isAlreadyApplied(repoDir, latest, local))) return

      const bun = await findBun()
      setRunning('download', 0)
      await runStagedUpdate(repoDir, bun)

      // Only a swap that actually happened is an update. Without a staged
      // binary the build produced nothing, and announcing "restart to use the
      // new build" would send the user to relaunch the same one.
      if (!applyStagedBinary(repoDir)) {
        throw new Error(`${STAGED_BINARY} was not produced by bun run update:staged`)
      }
      // Re-read from the tree rather than trusting `latest`: the pull resolves
      // the branch head itself, which may have moved on since the check.
      const built = (await currentFullSha(repoDir)) || latest
      writeState(repoDir, { lastCheckAt: Date.now(), builtSha: built })
      await trimNodeModules(repoDir)
      progressStore.setState(() => ({ status: 'ready', sha: built.slice(0, 7) }))
    } finally {
      await release().catch(() => {})
    }
  } catch (e) {
    clearUpdateProgress()
    logError(e)
  }
}
