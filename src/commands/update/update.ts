import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { LocalCommandCall } from '../../types/command.js'
import { isInBundledMode } from '../../utils/bundledMode.js'

const pexec = promisify(execFile)

/**
 * Locate the axa-chat source checkout to update. In a compiled binary,
 * process.execPath is the axa binary, which lives at the repo root next to
 * package.json / .git (true for both the dev checkout and installer-based
 * installs under ~/axa-chat).
 */
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
    if (existsSync(join(dir, '.git')) && existsSync(join(dir, 'package.json'))) {
      return dir
    }
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

export const call: LocalCommandCall = async () => {
  const repoDir = findRepoDir()
  if (!repoDir) {
    return {
      type: 'text',
      value:
        'Could not find the axa-chat source checkout to update. The running binary should sit in a git checkout (with .git + package.json). If you installed elsewhere, run `bun run update` in that directory.',
    }
  }

  let bun: string
  try {
    bun = await findBun()
  } catch (e) {
    return { type: 'text', value: (e as Error).message }
  }

  const before = await gitLine(repoDir, ['rev-parse', '--short', 'HEAD'])

  // Reuse the canonical `update` script: git pull && bun install && build:dev.
  try {
    await pexec(bun, ['run', 'update'], {
      cwd: repoDir,
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
  // (~400MB) isn't needed at runtime. Best-effort — a future update reinstalls
  // it via `bun install`. Don't fail the update if cleanup can't complete.
  await rm(join(repoDir, 'node_modules'), {
    recursive: true,
    force: true,
  }).catch(() => {})

  const after = await gitLine(repoDir, ['rev-parse', '--short', 'HEAD'])
  const head = await gitLine(repoDir, ['log', '-1', '--oneline'])
  const changed = before !== '' && after !== '' && before !== after

  return {
    type: 'text',
    value: changed
      ? `Updated ${before} → ${after}, rebuilt, and trimmed node_modules.\n${head}\nRestart axa to run the new build.`
      : `Already on the latest commit (${after || 'unknown'}); rebuilt and trimmed node_modules.\nRestart axa to be safe.`,
  }
}
