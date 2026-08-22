import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { delimiter as pathDelimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { LocalCommandCall } from '../../types/command.js'
import { isInBundledMode } from '../../utils/bundledMode.js'

const pexec = promisify(execFile)

/**
 * Marker file written by installs made without git, which are refreshed from a
 * source tarball instead of a checkout. Defined in `scripts/source.ts`; only
 * the name and the `commit` field are needed here, and duplicating those is
 * cheaper than pulling the build scripts into the CLI bundle.
 */
const INSTALL_MARKER = '.axa-install.json'

/**
 * Locate the axa-chat source tree to update. In a compiled binary,
 * process.execPath is the axa binary, which lives at the source root next to
 * package.json (true for the dev checkout and for installer-based installs
 * under ~/axa-chat, whether they were cloned with git or unpacked from a
 * tarball).
 */
function isRepoRoot(dir: string): boolean {
  if (!existsSync(join(dir, 'package.json'))) return false
  return existsSync(join(dir, '.git')) || existsSync(join(dir, INSTALL_MARKER))
}

/** Walk up from `start` until a source root or fs root. */
function walkUpToRepoRoot(start: string): string | null {
  let dir = start
  while (dir) {
    if (isRepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null // reached filesystem root
    dir = parent
  }
  return null
}

function findRepoDir(): string | null {
  const candidates: string[] = []
  try {
    const binary = isInBundledMode()
      ? realpathSync(process.execPath)
      : (process.argv[1] ?? '')
    if (binary) candidates.push(dirname(binary))
  } catch {
    // realpathSync can throw on a dangling symlink — fall through to fallbacks.
  }
  if (process.env.HOME) candidates.push(join(process.env.HOME, 'axa-chat'))
  candidates.push(process.cwd())

  for (const dir of candidates) {
    const root = walkUpToRepoRoot(dir)
    if (root) return root
  }
  return null
}

/** Find a runnable `bun` — PATH first, then the standard install locations. */
async function findBun(): Promise<string> {
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

async function gitLine(repoDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', ['-C', repoDir, ...args])
    return stdout.trim()
  } catch {
    return ''
  }
}

/** Short SHA of the recorded tarball revision, or '' when there is no marker. */
function markerSha(repoDir: string): string {
  try {
    const { commit } = JSON.parse(
      readFileSync(join(repoDir, INSTALL_MARKER), 'utf8'),
    ) as { commit?: string }
    return typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit)
      ? commit.slice(0, 7)
      : ''
  } catch {
    return ''
  }
}

/** Current revision, from git when there is a checkout and the marker otherwise. */
async function currentRevision(repoDir: string): Promise<string> {
  return (await gitLine(repoDir, ['rev-parse', '--short', 'HEAD'])) || markerSha(repoDir)
}

export const call: LocalCommandCall = async () => {
  const repoDir = findRepoDir()
  if (!repoDir) {
    return {
      type: 'text',
      value:
        'Could not find the axa-chat source tree to update. The running binary should sit at the source root, next to package.json and either .git or .axa-install.json. If you installed elsewhere, run `bun run update` in that directory.',
    }
  }

  let bun: string
  try {
    bun = await findBun()
  } catch (e) {
    return { type: 'text', value: (e as Error).message }
  }

  const before = await currentRevision(repoDir)

  // The `update` script (and build:dev) call `bun` by bare name in a subshell,
  // so bun's own directory must be on the child's PATH — axa's inherited PATH
  // may not include it (e.g. ~/.bun/bin). Prepend it when we resolved bun to an
  // absolute path. Use the platform path delimiter and the existing PATH key's
  // casing (Windows uses `Path`).
  const bunDir = dirname(bun)
  let childEnv: NodeJS.ProcessEnv = process.env
  if (bunDir && bunDir !== '.') {
    const pathKey =
      Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    childEnv = {
      ...process.env,
      [pathKey]: `${bunDir}${pathDelimiter}${process.env[pathKey] ?? ''}`,
    }
  }

  // Reuse the canonical `update` script: git pull && bun install && build:dev.
  try {
    await pexec(bun, ['run', 'update'], {
      cwd: repoDir,
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    })
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    const detail = (err.stderr || err.stdout || err.message || '').toString()
    return {
      type: 'text',
      value: `Update failed:\n${detail.slice(-1500)}`,
    }
  }

  // Trim build-time deps: the compiled binary is standalone, so node_modules
  // (~400MB) isn't needed at runtime. Only do this for the compiled binary —
  // in source mode (`bun run dev`) node_modules is required by the running
  // process. Best-effort; a future update reinstalls it via `bun install`.
  let trimmed = false
  if (isInBundledMode()) {
    trimmed = await rm(join(repoDir, 'node_modules'), {
      recursive: true,
      force: true,
    })
      .then(() => true)
      .catch(() => false)
  }

  const after = await currentRevision(repoDir)
  // Only a checkout can show the commit subject; tarball installs have no log.
  const head = await gitLine(repoDir, ['log', '-1', '--oneline'])
  const changed = before !== '' && after !== '' && before !== after
  const trimNote = trimmed ? ', and trimmed node_modules' : ''
  const headNote = head ? `\n${head}` : ''

  return {
    type: 'text',
    value: changed
      ? `Updated ${before} → ${after}, rebuilt${trimNote}.${headNote}\nRestart axa to run the new build.`
      : `Already on the latest commit (${after || 'unknown'}); rebuilt${trimNote}.\nRestart axa to be safe.`,
  }
}
