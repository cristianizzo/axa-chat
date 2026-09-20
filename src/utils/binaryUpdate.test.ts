import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  type BinaryInstall,
  type UpdateOutcome,
  describeOutcome,
  runBinaryUpdate,
} from './binaryUpdate.js'

/**
 * These drive the real update flow against a `file://` release origin.
 *
 * Nothing here is mocked: a tarball is built with the same `tar` the code
 * shells out to, hashed with the same algorithm the code checks, and served
 * from a directory laid out exactly like a GitHub Release. What is under test
 * is the *ordering* — what is on disk, and what the user is told, at each point
 * the sequence can fail — and a mocked filesystem would answer none of that.
 *
 * The "binaries" are shell scripts. The flow only ever runs them with
 * `--version` and cares whether they exit 0, so a script is a faithful stand-in
 * and a 173 MB one is not.
 */

let root: string
let origin: string
let install: BinaryInstall
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}

/** Publish `version` to the fake release origin, plus the channel manifest. */
function publish(version: string, body = `echo ${version}`): void {
  const stage = join(root, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'axa'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(stage, 'axa'), 0o755)

  const name = `axa-${version}-darwin-arm64.tar.gz`
  const dir = join(origin, `v${version}`)
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-czf', join(dir, name), 'axa'], { cwd: stage })

  const sha = new Bun.CryptoHasher('sha256')
  sha.update(readFileSync(join(dir, name)))

  mkdirSync(join(origin, 'stable'), { recursive: true })
  writeFileSync(
    join(origin, 'stable', 'manifest.json'),
    JSON.stringify({
      version,
      platforms: {
        'darwin-arm64': {
          url: `file://${join(dir, name)}`,
          sha256: sha.digest('hex'),
        },
      },
    }),
  )
}

/** Put `version` in versions/ directly, as an earlier install would have. */
function seedInstalled(version: string, body = `echo ${version}`): string {
  const path = join(install.versionsDir, version)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function pointAt(version: string): void {
  rmSync(install.launcher, { force: true })
  symlinkSync(join(install.versionsDir, version), install.launcher)
}

function run(): Promise<UpdateOutcome> {
  return runBinaryUpdate({ channel: 'stable', install })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'axa-binupd-'))
  origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })

  const dataDir = join(root, 'data')
  const versionsDir = join(dataDir, 'versions')
  mkdirSync(versionsDir, { recursive: true })
  mkdirSync(join(root, 'bin'), { recursive: true })

  install = {
    binaryPath: join(versionsDir, '1.0.0'),
    version: '1.0.0',
    dataDir,
    versionsDir,
    stagingDir: join(dataDir, 'staging', String(process.pid)),
    previousFile: join(dataDir, 'previous'),
    launcher: join(root, 'bin', 'axa'),
  }

  setEnv('AXA_RELEASE_BASE', `file://${origin}`)
  // Never the real one: recordResult() writes under the config home, and a test
  // that writes the user's live config hijacks their session.
  setEnv('CLAUDE_CONFIG_DIR', join(root, 'config'))

  seedInstalled('1.0.0')
  pointAt('1.0.0')
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test('a normal update installs, flips the launcher, and records what it replaced', async () => {
  publish('2.0.0')
  const outcome = await run()

  expect(outcome.kind).toBe('updated')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '2.0.0'))
  expect(readFileSync(install.previousFile, 'utf8').trim()).toBe('1.0.0')
})

test('the rollback target is the version being replaced, not the one running', async () => {
  // The shape this gets wrong: a session started on 1.0.0, a later update
  // already moved the launcher to 2.0.0, and now 3.0.0 arrives. What is being
  // replaced is 2.0.0. Recording 1.0.0 — the running version — sends
  // `--rollback` one version further back than the user asked for.
  seedInstalled('2.0.0')
  pointAt('2.0.0')
  publish('3.0.0')

  await run()

  expect(readFileSync(install.previousFile, 'utf8').trim()).toBe('2.0.0')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '3.0.0'))
})

test('the running version survives pruning even when it is neither active nor the rollback target', async () => {
  // Same divergence as above. 1.0.0 is executing; it is not what the launcher
  // serves and it is not what `previous` names, so the only thing keeping it on
  // disk is being exempt by name.
  for (const v of ['2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0']) seedInstalled(v)
  pointAt('6.0.0')
  publish('7.0.0')

  await run()

  expect(readdirSync(install.versionsDir)).toContain('1.0.0')
})

test('a release that does not start is discarded and the launcher is untouched', async () => {
  publish('2.0.0', 'exit 3')
  const outcome = await run()

  expect(outcome.kind).toBe('failed')
  // Not installed at all, so the message must say exactly that.
  if (outcome.kind === 'failed') {
    expect(outcome.reason).toContain('Nothing was replaced')
  }
  expect(readdirSync(install.versionsDir)).not.toContain('2.0.0')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '1.0.0'))
})

test('a checksum mismatch is refused and nothing reaches versions/', async () => {
  publish('2.0.0')
  const manifestPath = join(origin, 'stable', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.platforms['darwin-arm64'].sha256 = '0'.repeat(64)
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const outcome = await run()

  expect(outcome.kind).toBe('failed')
  expect(readdirSync(install.versionsDir)).not.toContain('2.0.0')
})

test('a failure after the version is written says so, instead of "nothing was replaced"', async () => {
  // The flip is made to fail by taking write permission off the launcher's
  // directory, which is the same shape as the measured EACCES case: the version
  // IS on disk by then, and telling the user otherwise is a false statement
  // about which binary their next launch runs.
  publish('2.0.0')
  const binDir = join(root, 'bin')
  chmodSync(binDir, 0o555)
  try {
    const outcome = await run()

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.reason).not.toContain('Nothing was replaced')
      expect(outcome.reason).toContain('still runs 1.0.0')
      expect(outcome.reason).toContain('ln -sfn')
    }
    expect(readdirSync(install.versionsDir)).toContain('2.0.0')
  } finally {
    chmodSync(binDir, 0o755)
  }
})

test('"already latest" repairs a launcher that points somewhere else', async () => {
  // The state the previous test leaves behind: current by version number, but
  // the launcher never moved. Reporting "you are current" on top of it is the
  // one answer that stops the user looking.
  publish('1.0.0')
  seedInstalled('0.9.0')
  pointAt('0.9.0')

  const outcome = await run()

  expect(outcome.kind).toBe('already-latest')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '1.0.0'))
  expect(describeOutcome(outcome, install)).toContain('repointed')
})

test('"already latest" says nothing extra when the launcher is correct', async () => {
  publish('1.0.0')
  const outcome = await run()

  expect(outcome.kind).toBe('already-latest')
  expect(describeOutcome(outcome, install)).toBe(
    'Already on the latest release (1.0.0).',
  )
})

test('a manifest naming a version with .. is refused before it becomes a path', async () => {
  publish('2.0.0')
  const manifestPath = join(origin, 'stable', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = '../../escape'
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const outcome = await run()

  expect(outcome.kind).toBe('failed')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '1.0.0'))
})
