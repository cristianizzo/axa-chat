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
let apiServer: ReturnType<typeof Bun.serve> | undefined
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

/**
 * Stand in for api.github.com.
 *
 * `handler` answers the two calls the API route makes — the release lookup that
 * yields an asset id, and the asset fetch that yields the manifest bytes — so a
 * test can break either one independently. Returning `null` means "fail this
 * request", which is how the fallback gets exercised.
 */
function serveApi(handler: (path: string) => unknown | null): void {
  apiServer = Bun.serve({
    port: 0,
    fetch(request) {
      const body = handler(new URL(request.url).pathname)
      if (body === null) return new Response('nope', { status: 500 })
      return Response.json(body)
    },
  })
  setEnv('AXA_RELEASE_API_BASE', `http://localhost:${apiServer.port}`)
}

/** The release-lookup shape the API route reads an asset id out of. */
const RELEASE_WITH_MANIFEST = { assets: [{ name: 'manifest.json', id: 42 }] }

afterEach(() => {
  apiServer?.stop(true)
  apiServer = undefined
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

/*
 * The API route exists because the channel manifest lives at a FIXED url whose
 * content changes every release, and GitHub's CDN serves a pre-release copy of
 * it for an opaque TTL — measured live: `?t=<now>` and a `Cache-Control:
 * no-cache` request header both came back with the same `age` as the plain url,
 * so there is no cache-buster to add. Reading the manifest through an asset id
 * instead gives a url that is unique per upload, which cannot be stale.
 *
 * These drive it through a fixture rather than api.github.com: the point is the
 * *fallback ordering*, and a route that only ever succeeds proves none of it.
 */

test('the API route is preferred over the cached url, and says nothing when it works', async () => {
  // The two routes are made to DISAGREE, which is the only arrangement that can
  // tell them apart — this is exactly the live situation being fixed, where the
  // cached url still served the version from before the release. Publishing the
  // same version to both would pass whichever route ran.
  publish('2.0.0')
  const cached = readFileSync(join(origin, 'stable', 'manifest.json'), 'utf8')
  publish('3.0.0')
  const fresh = readFileSync(join(origin, 'stable', 'manifest.json'), 'utf8')
  writeFileSync(join(origin, 'stable', 'manifest.json'), cached)

  serveApi(path =>
    path.endsWith('/assets/42') ? JSON.parse(fresh) : RELEASE_WITH_MANIFEST,
  )

  const outcome = await run()

  expect(outcome.kind).toBe('updated')
  if (outcome.kind === 'updated') {
    expect(outcome.to).toBe('3.0.0')
    // Nothing went wrong, so there is nothing to say. A note on the happy path
    // is noise, and noise is what stops the real one being read.
    expect(outcome.notes).toBeUndefined()
  }
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '3.0.0'))
})

test('an unreachable API falls back to the cached url and SAYS the answer may be stale', async () => {
  // The whole point of the note. Falling back silently reinstates the defect
  // this route list was added to fix: the cached copy answers "already on the
  // latest release" with a version that was current before the release being
  // looked for, and that is indistinguishable from a correct answer.
  publish('2.0.0')
  serveApi(() => null)

  const outcome = await run()

  expect(outcome.kind).toBe('updated')
  if (outcome.kind === 'updated') {
    expect(outcome.notes?.join('\n')).toContain('cached copy')
  }
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '2.0.0'))
})

test('an API answer that is 200 but not a manifest is a failed route, not a failed update', async () => {
  // The shape that makes per-route validation necessary: a wrong Accept header
  // returns the asset's *metadata*, which is a 200 carrying valid JSON. Nothing
  // in the fetch can tell it apart — only validating this route's answer before
  // accepting it can, and if validation ran once at the end instead, this would
  // throw past a working fallback sitting right there.
  publish('2.0.0')
  serveApi(path =>
    path.endsWith('/assets/42')
      ? { id: 42, name: 'manifest.json', size: 391, content_type: 'text/plain' }
      : RELEASE_WITH_MANIFEST,
  )

  const outcome = await run()

  expect(outcome.kind).toBe('updated')
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '2.0.0'))
})

test('when every route fails, the report names every route', async () => {
  // Reporting only the last one hides half of why the update could not start,
  // and the API arm is the half nobody would think to look for.
  serveApi(() => null)
  rmSync(join(origin, 'stable'), { recursive: true, force: true })

  const outcome = await run()

  expect(outcome.kind).toBe('failed')
  if (outcome.kind === 'failed') {
    expect(outcome.reason).toContain(`localhost:${apiServer?.port}`)
    expect(outcome.reason).toContain('manifest.json')

    // ...and names each of them ONCE. Three separate places add identification
    // to this report — the route label, `fetchWithTimeout`'s url-naming and the
    // caller's own wrapper — and each was independently reasonable, which is how
    // the message ended up repeating both its opening sentence and the download
    // url. A pair of `toContain`s cannot see that; counting can.
    const occurrences = (needle: string) =>
      outcome.reason.split(needle).length - 1
    expect(occurrences('Could not read the')).toBe(1)
    // The full `file://` url, not the bare path: ENOENT quotes the path without
    // the scheme, so counting the path alone finds two legitimate mentions and
    // reports a duplication that is not there.
    expect(occurrences(`file://${origin}/stable/manifest.json`)).toBe(1)
  }
  expect(readlinkSync(install.launcher)).toBe(join(install.versionsDir, '1.0.0'))
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
