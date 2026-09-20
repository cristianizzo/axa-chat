import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isCompiledBinary } from './bundledMode.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logError } from './log.js'

/**
 * Updating a binary install.
 *
 * The shape, and the one thing worth understanding before changing anything
 * here: **versions are bare files named after their version, and the launcher
 * is a symlink to one of them.**
 *
 *   ~/.local/share/axa/versions/2.1.88   the executable itself
 *   ~/.local/share/axa/staging/          download + verify, cleared after
 *   ~/.local/share/axa/previous          rollback target, one version string
 *   ~/.local/bin/axa                     symlink -> versions/2.1.88
 *
 * `rename(2)` is atomic, and a process that is already running the old version
 * holds its original inode — so replacing the binary underneath a live session
 * is a non-event, and nothing here kills, respawns or re-execs anything. That
 * is not a simplification of a restart design, it is the reason no restart
 * design is needed: `process.execve` does not exist in Bun (measured on
 * 1.3.11), a detached script cannot take the terminal back from the shell, and
 * spawn+wait would strand this session and its accumulated context. The one
 * honest cost is that the new version is live on the *next* launch, not in the
 * session that ran the update.
 *
 * Staging deliberately lives under the data dir rather than under `~/.cache`:
 * the move into `versions/` has to be a rename on a single filesystem to be
 * atomic, and `~/.cache` and `~/.local/share` are not guaranteed to be the
 * same one. It is still outside `versions/`, so a partial download is never a
 * candidate version.
 *
 * This module handles binary installs only. A developer's checkout is updated
 * by `sourceUpdate.ts`, which pulls and rebuilds; `/update` picks between them
 * by asking where `process.execPath` actually landed.
 */

/** The `channel` segment of the release URL. See RELEASE_BASE below. */
const DEFAULT_CHANNEL = 'stable'

const REPO_SLUG = 'cristianizzo/axa-chat'

/**
 * Where releases are fetched from.
 *
 * `AXA_RELEASE_BASE` is the same override `install.sh` honours, and both halves
 * of the name are ours. It exists so this path can be exercised against a local
 * origin: an updater is almost entirely error handling, and error handling that
 * has never been run is a guess. It is documented rather than hidden because a
 * hidden env var that redirects a download is worse than a stated one, and
 * anyone who can set it in your environment can already replace the binary it
 * would point at.
 */
function releaseBase(): string {
  return (
    process.env.AXA_RELEASE_BASE ||
    `https://github.com/${REPO_SLUG}/releases/download`
  )
}

/**
 * Where the *API* route reads the channel manifest from — deliberately a
 * different override from `AXA_RELEASE_BASE`.
 *
 * Two knobs rather than one because they answer different questions.
 * `AXA_RELEASE_BASE` chooses an origin and is set to a `file://` tree by the
 * tests, which have no API to talk to; folding the API onto it would mean the
 * API route is *disabled* in every test and so never executed anywhere. A
 * separate name lets a fixture server stand in for api.github.com without
 * disturbing the origin.
 */
function releaseApiBase(): string {
  return process.env.AXA_RELEASE_API_BASE || 'https://api.github.com'
}

/**
 * Versions kept on disk, not counting the active one and the rollback target,
 * which are never pruned. 173 MB each, and they are the only recovery that
 * exists when a release will not start.
 */
const RETAIN = 3

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000
const METADATA_TIMEOUT_MS = 60 * 1000
/**
 * The whole API route — both calls — not each one, and deliberately far shorter
 * than `METADATA_TIMEOUT_MS`.
 *
 * The two budgets are asymmetric because the routes are: the download url is the
 * route that *must* succeed, so it gets the generous 60s, while the API route is
 * only ever a preference that can save the caller from a stale answer. A
 * preference must not be able to cost more than it can save. Measured live
 * against api.github.com the whole route answers in ~850ms, and the failure this
 * bounds is the one that does not answer at all — a proxy that drops rather than
 * refuses, which is the first scenario this route exists for. Without the bound
 * that is 60s per call, twice, before the route that used to be the only one
 * even starts, with no progress output: indistinguishable from a hang.
 */
const API_BUDGET_MS = 10 * 1000
/** Generous: a first run of a 173 MB binary is cold-cache and page-faults in. */
const SMOKE_TIMEOUT_MS = 60 * 1000

/**
 * Only `darwin-arm64` is published. This is a deliberate scope, not an
 * oversight: the build is host-targeted, so every additional platform is a
 * second CI runner and a second artifact nobody here can verify.
 */
export const SUPPORTED_PLATFORM = 'darwin-arm64'

export type UpdateOutcome =
  | { kind: 'not-a-binary-install' }
  | { kind: 'already-latest'; version: string; notes?: string[] }
  | { kind: 'updated'; from: string; to: string; notes?: string[] }
  | { kind: 'failed'; reason: string }

type ManifestPlatform = {
  url: string
  sha256: string
  size?: number
}

type Manifest = {
  schema: number
  channel: string
  version: string
  platforms: Record<string, ManifestPlatform>
}

export type BinaryInstall = {
  /** The real path of the running executable. */
  binaryPath: string
  /** The version directory entry name, which *is* the version. */
  version: string
  dataDir: string
  versionsDir: string
  stagingDir: string
  previousFile: string
  /** Where the launcher symlink is expected to be. May not exist. */
  launcher: string
}

function dataDir(): string {
  return process.env.AXA_DATA_DIR || join(homedir(), '.local', 'share', 'axa')
}

function binDir(): string {
  return process.env.AXA_BIN_DIR || join(homedir(), '.local', 'bin')
}

/**
 * Where this process is installed, when it is a released binary.
 *
 * The test is positional and deliberately strict: the running executable must
 * be a file sitting directly inside `<dataDir>/versions/`. Nothing is inferred
 * from the version string, from a marker file, or from `argv` — the first two
 * are writable by anyone and the third is a virtual `/$bunfs/…` path inside a
 * compiled binary, which is the mistake that broke `/update` before this
 * module existed.
 *
 * Returns null for a dev checkout, for `bun run`, and for a binary someone
 * copied elsewhere. Every one of those is a case where updating in place would
 * be the wrong thing to do rather than a case we failed to handle.
 */
export function currentBinaryInstall(): BinaryInstall | null {
  if (!isCompiledBinary()) return null

  let binaryPath: string
  try {
    binaryPath = realpathSync(process.execPath)
  } catch {
    // A dangling symlink or a deleted binary. Not something to repair here.
    return null
  }

  const versionsDir = join(dataDir(), 'versions')
  let realVersionsDir: string
  try {
    // realpath both sides before comparing: on macOS the home directory can be
    // reached through /System/Volumes/Data, and a string compare against an
    // unresolved path would reject a perfectly normal install.
    realVersionsDir = realpathSync(versionsDir)
  } catch {
    return null
  }
  if (dirname(binaryPath) !== realVersionsDir) return null

  const version = basename(binaryPath)
  if (!isSafeVersion(version)) return null

  return {
    binaryPath,
    version,
    dataDir: dataDir(),
    versionsDir,
    // Per-process. The update flow clears its staging dir before using it, so a
    // path shared with a second updater — another session, or install.sh run
    // from a terminal — means one of them deletes the other's verified binary
    // in the window between the smoke test and the rename into versions/.
    stagingDir: join(dataDir(), 'staging', String(process.pid)),
    previousFile: join(dataDir(), 'previous'),
    launcher: join(binDir(), 'axa'),
  }
}

/**
 * A version names a file inside `versions/`, so it is validated before it is
 * ever joined onto a path. `..` in a manifest would otherwise let a release
 * write outside the directory it is supposed to own.
 */
function isSafeVersion(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version) && !version.includes('..')
}

/**
 * Fetch `url` and hand the response to `consume`, with the timeout covering
 * both.
 *
 * The consumer is a callback rather than the returned value on purpose. `fetch`
 * resolves as soon as the response *headers* arrive, so clearing the timer at
 * that point disarms it for the entire body — which for the release archive is
 * ~173 MB and the only part that takes any real time. A server that answers and
 * then stalls mid-stream would hang the update indefinitely with no timeout
 * left to fire and nothing printed. Keeping the timer and the abort signal live
 * until the body has been read is what makes DOWNLOAD_TIMEOUT_MS mean what its
 * name says.
 */
async function fetchWithTimeout<T>(
  url: string,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
  headers?: Record<string, string>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`)
    }
    return await consume(response)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s fetching ${url}.`,
      )
    }
    // `fetch` reports a connection failure as a bare "Unable to connect. Is the
    // computer able to access the url?" — which names no url. Measured with both
    // manifest routes broken, the whole report was that one sentence twice over,
    // with nothing to say whether the API host, the download host or both were
    // unreachable. `includes` rather than an unconditional append, so the
    // messages that already carry their url are not given it a second time.
    const message = (error as Error | undefined)?.message
    if (typeof message === 'string' && !message.includes(url)) {
      throw new Error(`${message} (${url})`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the channel manifest through the GitHub API instead of the download URL.
 *
 * The channel pointer is a *fixed* URL whose content changes on every release,
 * which is the one shape a CDN handles worst. Measured against GitHub: a copy
 * from before the release is served for an opaque TTL — the response carries an
 * `age` and no `cache-control` at all — and neither `?t=<now>` nor a
 * `Cache-Control: no-cache` request header displaces it. All three spellings
 * came back with the same `age`, so there is no cache-buster to add. A user
 * running `/update` shortly after a release is told they are already current.
 *
 * This sidesteps caching rather than fighting it. A release asset's id is minted
 * when the asset is uploaded, so `releases/assets/<id>` is a different URL for
 * every published manifest, and a cached entry for one id can only ever hold the
 * bytes uploaded under that id. Freshness stops being load-bearing: correctness
 * comes from the id. Only the id lookup itself can be stale, and that response
 * carries an explicit `max-age=60`.
 *
 * It is a preference, not a requirement, and the caller falls back to the
 * download URL on any failure here: api.github.com is a second host a proxy may
 * block while allowing github.com, it is rate limited to 60 requests an hour for
 * an unauthenticated caller, and `AXA_RELEASE_BASE` points the tests at a
 * `file://` origin that has no API at all.
 */
async function fetchManifestViaApi(channel: string): Promise<unknown> {
  // Encoded, unlike the download url built from the same channel. That one
  // addresses a release asset and a bad channel 404s; this one addresses
  // api.github.com, which has a far larger surface reachable through a path
  // segment, and the channel arrives from the environment.
  const api = `${releaseApiBase()}/repos/${REPO_SLUG}/releases`
  // One deadline spanning both calls rather than a budget each, so the route's
  // worst case is what `API_BUDGET_MS` says it is instead of twice it.
  const deadline = Date.now() + API_BUDGET_MS
  const remaining = () => Math.max(1, deadline - Date.now())

  const release: unknown = await fetchWithTimeout(
    `${api}/tags/${encodeURIComponent(channel)}`,
    remaining(),
    response => response.json(),
    // The user-agent matches `resolveLatestCommit` in sourceUpdate.ts, the
    // other caller of this host. Bun sends one by default so this works either
    // way; naming ourselves is what makes a rate-limit answer attributable.
    {
      accept: 'application/vnd.github+json',
      'user-agent': 'axa-chat-updater',
    },
  )

  const assets = (release as { assets?: unknown }).assets
  if (!Array.isArray(assets)) {
    throw new Error(`the ${channel} release carries no assets array`)
  }
  const asset = assets.find(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { name?: unknown }).name === 'manifest.json',
  )
  const id = (asset as { id?: unknown } | undefined)?.id
  // `Number.isSafeInteger`, not `Number.isInteger`: the latter admits NaN
  // (false, fine) but also 1e21 (true — it IS a mathematical integer), which
  // interpolates into the url as the literal "1e+21". Copilot caught this;
  // the comment this replaces claimed `Number.isInteger` already excluded it,
  // which is false — measured: `Number.isInteger(1e21) === true`.
  if (!Number.isSafeInteger(id) || (id as number) <= 0) {
    throw new Error(
      `the ${channel} release has no manifest.json asset with a usable id`,
    )
  }

  // Without this Accept header the endpoint returns the asset's *metadata*
  // rather than its bytes. That is a 200 carrying valid JSON, so it is caught
  // by validating this route's answer before accepting it, not by the fetch.
  return await fetchWithTimeout(
    `${api}/assets/${id as number}`,
    remaining(),
    response => response.json(),
    {
      accept: 'application/octet-stream',
      'user-agent': 'axa-chat-updater',
    },
  )
}

/**
 * Validated rather than cast. This object decides what gets downloaded and what
 * it is checked against, so a malformed field must stop the update rather than
 * flow into a path or a comparison.
 *
 * Separate from the fetching so it can run *per route*: a route that answers 200
 * with a JSON body that is not a manifest — an API error envelope, or the asset
 * metadata that comes back when the Accept header is wrong — has not produced a
 * manifest, and must be treated as a failed route rather than as an answer that
 * then fails validation for everyone.
 */
function validateManifest(parsed: unknown, channel: string): Manifest {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the ${channel} manifest is not a JSON object`)
  }
  const m = parsed as Partial<Manifest>
  if (typeof m.version !== 'string' || !isSafeVersion(m.version)) {
    throw new Error(
      `the ${channel} manifest has no usable version field (got ${JSON.stringify(m.version)})`,
    )
  }
  if (typeof m.platforms !== 'object' || m.platforms === null) {
    throw new Error(`the ${channel} manifest has no platforms map`)
  }
  return {
    schema: typeof m.schema === 'number' ? m.schema : 1,
    channel: typeof m.channel === 'string' ? m.channel : channel,
    version: m.version,
    platforms: m.platforms,
  }
}

type ManifestRoute = { label: string; fetch: () => Promise<unknown> }

/**
 * The routes to the channel manifest, freshest first.
 *
 * The API route is omitted when `AXA_RELEASE_BASE` is set *and*
 * `AXA_RELEASE_API_BASE` is not — both halves matter, and stating only the
 * first would describe a function that no test could reach the API route
 * through. An origin override on its own points at a local tree that has no API
 * and trying one there spends a timeout to learn nothing; setting the second
 * alongside it is how a fixture stands in for api.github.com.
 *
 * They are two overrides rather than one because they answer different
 * questions: folding them together would conflate "which origin" with "which
 * protocol", and the arm added to fix a live defect would then be disabled in
 * every test and so exercised nowhere.
 */
function manifestRoutes(channel: string): ManifestRoute[] {
  const url = `${releaseBase()}/${channel}/manifest.json`
  const download: ManifestRoute = {
    label: url,
    fetch: () =>
      fetchWithTimeout(url, METADATA_TIMEOUT_MS, async response => {
        try {
          return await response.json()
        } catch (error) {
          // Not prefixed with the url: this route's `label` already is the url,
          // and `fetchManifest` prints `<label> — <message>`. Naming it here too
          // printed it twice on one line. The identification the old comment
          // here was protecting is still there, it just comes from the label.
          throw new Error(`did not return JSON: ${(error as Error).message}`)
        }
      }),
  }
  // An origin override with no API override is a local tree: there is no API
  // there, and trying one spends a timeout to learn nothing. Setting both is
  // how a test puts a fixture in the API's place.
  if (process.env.AXA_RELEASE_BASE && !process.env.AXA_RELEASE_API_BASE) {
    return [download]
  }
  return [
    { label: releaseApiBase(), fetch: () => fetchManifestViaApi(channel) },
    download,
  ]
}

export async function fetchManifest(
  channel: string,
): Promise<{ manifest: Manifest; notes: string[] }> {
  const failures: string[] = []

  for (const route of manifestRoutes(channel)) {
    let manifest: Manifest
    try {
      manifest = validateManifest(await route.fetch(), channel)
    } catch (error) {
      // The label identifies the route; the message often identifies it too, and
      // more precisely — `fetchWithTimeout` names the exact url it was on, which
      // for the API route is the specific endpoint rather than just the host.
      // Prefixing unconditionally printed the download route's url twice on one
      // line, since there the label *is* the url.
      const message = (error as Error).message
      failures.push(
        message.includes(route.label) ? message : `${route.label} — ${message}`,
      )
      continue
    }

    // Falling back is not free, and staying quiet about it would reinstate the
    // exact defect this route list exists to fix: the cached copy answers
    // "you are already on the latest release" with a version that was current
    // before the release being looked for. Succeeding on the first route is the
    // only case that says nothing.
    const notes =
      failures.length === 0
        ? []
        : [
            `The freshest route to the ${channel} manifest did not answer, so this ` +
              `came from a cached copy that can be a few minutes behind. If a release ` +
              `was just published, try again shortly.\n` +
              failures.map(f => `  ${f}`).join('\n'),
          ]
    return { manifest, notes }
  }

  throw new Error(
    `Could not read the ${channel} release manifest. Every route failed:\n` +
      failures.map(f => `  ${f}`).join('\n'),
  )
}

function platformKey(): string {
  return `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`
}

/**
 * Download to `dest` and return the hex SHA-256 of what actually landed on
 * disk.
 *
 * Hashed from the written file rather than from the response stream: the point
 * of the check is that the *file we are about to execute* matches, and hashing
 * the stream would still pass if the write were short.
 */
async function downloadAndHash(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<string> {
  const chunks = await fetchWithTimeout(
    url,
    DOWNLOAD_TIMEOUT_MS,
    async response => {
      const lengthHeader = response.headers.get('content-length')
      const total = lengthHeader ? Number(lengthHeader) : null

      const body = response.body
      if (!body) throw new Error(`No response body for ${url}`)

      const collected: Uint8Array[] = []
      let received = 0
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          collected.push(value)
          received += value.byteLength
          onProgress?.(received, total && Number.isFinite(total) ? total : null)
        }
      }
      return collected
    },
  )

  await Bun.write(dest, new Blob(chunks as BlobPart[]))

  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(dest).arrayBuffer())
  return hasher.digest('hex')
}

/**
 * Extract the single `axa` entry from a gzipped tar into `destDir`.
 *
 * Shelling out to `tar` rather than decoding the archive here: `tar` ships with
 * macOS, it is the same tool install.sh uses, and a hand-rolled reader is
 * another thing that can be subtly wrong in the one path that must not be.
 */
async function extractArchive(archive: string, destDir: string): Promise<string> {
  const proc = Bun.spawn(['tar', '-xzf', archive, '-C', destDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`tar failed to extract the release archive: ${stderr.trim()}`)
  }
  const extracted = join(destDir, 'axa')
  if (!existsSync(extracted)) {
    throw new Error(
      'The release archive did not contain an `axa` executable. Refusing to guess at what else is in it.',
    )
  }
  return extracted
}

/**
 * Start the downloaded binary once and require it to exit cleanly.
 *
 * This is the check a checksum cannot do. The hash says "these are the bytes
 * that were published"; it says nothing about whether they run *here*. The
 * failures it catches are the ones that would otherwise leave a user with a
 * launcher pointing at something that will not start, which is the single
 * outcome this module exists to prevent — a broken update path cannot fix
 * itself.
 *
 * Deliberately not asserting that the reported version matches the manifest:
 * that is checked in CI at publish time, where refusing costs nobody anything.
 * Here a mismatch would mean discarding a working binary over a stamp.
 */
async function assertBinaryStarts(path: string, version: string): Promise<void> {
  const proc = Bun.spawn([path, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    // No stdin: this must not be able to block waiting for input.
    stdin: 'ignore',
  })
  const timer = setTimeout(() => proc.kill(), SMOKE_TIMEOUT_MS)
  let exitCode: number
  let stderr: string
  try {
    ;[exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])
  } finally {
    clearTimeout(timer)
  }

  if (exitCode !== 0) {
    throw new Error(
      `The downloaded ${version} binary did not start (\`--version\` exited ${exitCode}).` +
        (stderr.trim() ? `\n${stderr.trim().slice(0, 500)}` : '') +
        '\nIt was discarded rather than installed.',
    )
  }
}

/**
 * Repoint the launcher symlink atomically.
 *
 * A new symlink is created under a temporary name and renamed over the old
 * one. `ln -sfn` — and an unlink/symlink pair here — leaves a window in which
 * `axa` does not exist on PATH; `rename(2)` has none.
 *
 * Refuses when the launcher exists and is not a symlink into our versions
 * directory. Something else put it there, and overwriting a launcher we do not
 * own is not recoverable with this tool.
 */
/**
 * The version the launcher points at right now, or null if it points nowhere or
 * outside `versions/`.
 *
 * Not the same thing as `install.version`, which is the version of the process
 * asking. They diverge whenever a session was started before an update, or
 * after a `--rollback` run from another terminal, and the difference matters in
 * both places it is used: the rollback target is "what was active", and pruning
 * must spare "what is running".
 */
function activeVersion(install: BinaryInstall): string | null {
  try {
    const target = realpathSync(install.launcher)
    if (dirname(target) !== realpathSync(install.versionsDir)) return null
    const version = basename(target)
    return isSafeVersion(version) ? version : null
  } catch {
    return null
  }
}

export function pointLauncherAt(install: BinaryInstall, version: string): void {
  const target = join(install.versionsDir, version)

  let existingTarget: string | null = null
  try {
    existingTarget = realpathSync(install.launcher)
  } catch {
    // Missing or dangling. Both are ours to create.
  }
  if (
    existingTarget !== null &&
    dirname(existingTarget) !== realpathSync(install.versionsDir)
  ) {
    throw new Error(
      `${install.launcher} points at ${existingTarget}, which is not one of our installed versions. ` +
        'Refusing to replace a launcher this installer did not create.',
    )
  }

  mkdirSync(dirname(install.launcher), { recursive: true })
  const tmp = join(dirname(install.launcher), `.axa.${process.pid}.tmp`)
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  renameSync(tmp, install.launcher)
}

/**
 * Drop old versions, keeping the newest RETAIN plus the active one and the
 * rollback target.
 *
 * The active and previous versions are exempt rather than counted, because
 * counting them would prune the rollback target as soon as a third version
 * arrived — and the rollback target is the only recovery that exists when a
 * release will not start.
 *
 * Best-effort: a version that cannot be removed is a disk-space problem, not a
 * reason to fail an update that has already succeeded.
 */
function pruneVersions(
  install: BinaryInstall,
  active: string,
  running: string,
): void {
  let previous = ''
  try {
    previous = readFileSync(install.previousFile, 'utf8').trim()
  } catch {
    // No rollback target recorded yet.
  }

  let entries: string[]
  try {
    entries = readdirSync(install.versionsDir).filter(name => {
      try {
        return statSync(join(install.versionsDir, name)).isFile()
      } catch {
        return false
      }
    })
  } catch {
    return
  }

  // `running` is exempt on top of the other two. A session started before an
  // earlier update is executing that file, and deleting it takes away the one
  // version the user has just demonstrated works on this machine — which is
  // exactly what they would want to go back to if the new one misbehaves.
  const prunable = entries
    .filter(v => v !== active && v !== previous && v !== running)
    .sort(compareVersionsDescending)

  for (const version of prunable.slice(RETAIN)) {
    try {
      rmSync(join(install.versionsDir, version), { force: true })
    } catch (error) {
      logError(error)
    }
  }
}

/**
 * Newest first. Numeric segments compare numerically so that 2.1.10 outranks
 * 2.1.9, which a plain string sort gets backwards; anything non-numeric falls
 * back to a string compare rather than being silently treated as 0.
 */
function compareVersionsDescending(a: string, b: string): number {
  const as = a.split(/[.-]/)
  const bs = b.split(/[.-]/)
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const av = as[i] ?? ''
    const bv = bs[i] ?? ''
    const an = Number(av)
    const bn = Number(bv)
    if (Number.isInteger(an) && Number.isInteger(bn) && av !== '' && bv !== '') {
      if (an !== bn) return bn - an
      continue
    }
    if (av !== bv) return bv.localeCompare(av)
  }
  return 0
}

/**
 * Record the outcome beside the config, in the same spirit as the reference
 * implementation's `.last-update-result.json`: when an update goes wrong the
 * session that saw the error is usually gone by the time anyone asks.
 *
 * Under the config home, which `CLAUDE_CONFIG_DIR` relocates — so a test with
 * an isolated config dir cannot write the user's real one.
 */
function recordResult(result: Record<string, unknown>): void {
  try {
    const path = join(getClaudeConfigHomeDir(), '.axa-last-update.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
    )
  } catch (error) {
    // Losing the record is not a reason to fail an update that worked.
    logError(error)
  }
}

/**
 * Download, verify and install the newest release on the channel, then flip the
 * launcher.
 *
 * Ordering is the whole design: nothing that the running install depends on is
 * touched until a fully downloaded, checksum-verified binary exists on disk.
 * Every failure before the final rename leaves the previous version active and
 * runnable, which is the property that matters most here — a broken update path
 * cannot fix itself.
 */
export async function runBinaryUpdate(options?: {
  channel?: string
  onProgress?: (received: number, total: number | null) => void
  /**
   * Which install to operate on. Production never passes this — it is here so
   * the flow can be exercised at all. `currentBinaryInstall()` returns null
   * unless the process is a compiled binary living in `versions/`, which is
   * never true under a test runner, so without this seam the entire download →
   * verify → flip sequence is unreachable outside a real release.
   */
  install?: BinaryInstall
}): Promise<UpdateOutcome> {
  const install = options?.install ?? currentBinaryInstall()
  if (!install) return { kind: 'not-a-binary-install' }

  const channel = options?.channel ?? process.env.AXA_CHANNEL ?? DEFAULT_CHANNEL

  let manifest: Manifest
  // Carried all the way to the outcome. The only thing a stale manifest can say
  // is "you are already on the latest release", which is also what a correct one
  // says — so if the fresh route was skipped, the note is the user's only signal
  // that the answer is worth repeating in a minute.
  let manifestNotes: string[]
  try {
    const fetched = await fetchManifest(channel)
    manifest = fetched.manifest
    manifestNotes = fetched.notes
  } catch (error) {
    // Passed through rather than prefixed. `fetchManifest` is the only thing
    // that throws here and its message already opens with this exact sentence,
    // so a wrapper printed it twice — once as a prefix and once as the body.
    const reason = (error as Error).message
    recordResult({ outcome: 'failed', from: install.version, reason })
    return { kind: 'failed', reason }
  }

  /**
   * Append the staleness note to a failure downstream of the manifest fetch.
   *
   * Every such failure — no artifact for this platform, a checksum that does not
   * match — is a complaint about the *contents* of the manifest, and if those
   * contents came from the cached route they can name an asset that has since
   * been clobbered. That is the single fact which explains the failure, and
   * without it the report accuses a release that is actually fine. The `failed`
   * outcome carries no notes field, so it goes into the reason itself.
   */
  const withManifestNotes = (reason: string): string =>
    manifestNotes.length === 0
      ? reason
      : `${reason}\n\n${manifestNotes.join('\n')}`

  if (manifest.version === install.version) {
    // "Latest" is a claim about what the next launch runs, not about this
    // process. They come apart whenever an earlier attempt installed a version
    // and failed before, or during, the flip — and that is precisely the state
    // the failure paths below can leave. Reporting "you are current" on top of
    // it is the one answer that stops the user looking, so the launcher is
    // repaired here rather than assumed.
    const active = activeVersion(install)
    if (active !== install.version) {
      try {
        pointLauncherAt(install, install.version)
      } catch (error) {
        // Caught by Copilot: this is a failure downstream of the manifest fetch
        // exactly like the three below it, and had been left out of
        // `withManifestNotes` because it sits earlier in the function, above
        // where that helper is defined at the time this branch was written.
        const reason = withManifestNotes(
          `You are on the latest release (${install.version}), but ${install.launcher} ` +
            `points at ${active ?? 'nothing this installer recognises'} and could not be ` +
            `repaired: ${(error as Error).message}\n` +
            `Fix it with: ln -sfn ${join(install.versionsDir, install.version)} ${install.launcher}`,
        )
        recordResult({ outcome: 'failed', from: install.version, reason })
        return { kind: 'failed', reason }
      }
      return {
        kind: 'already-latest',
        version: install.version,
        notes: [
          ...manifestNotes,
          `${install.launcher} was pointing at ${active ?? 'nothing'} rather than ` +
            `${install.version}; it has been repointed.`,
        ],
      }
    }
    return {
      kind: 'already-latest',
      version: install.version,
      ...(manifestNotes.length > 0 ? { notes: manifestNotes } : {}),
    }
  }

  const key = platformKey()
  const platform = manifest.platforms[key]
  if (!platform || typeof platform.url !== 'string' || typeof platform.sha256 !== 'string') {
    const reason = withManifestNotes(
      `Release ${manifest.version} publishes no artifact for ${key}. ` +
        `Published platforms: ${Object.keys(manifest.platforms).join(', ') || 'none'}. ` +
        `Nothing was changed; you are still on ${install.version}.`,
    )
    recordResult({ outcome: 'failed', from: install.version, to: manifest.version, reason })
    return { kind: 'failed', reason }
  }

  const staging = install.stagingDir
  // How far the sequence below got, because the catch at the end covers all of
  // it and the three states are not interchangeable to the user: nothing
  // written, written-but-not-active, and active. Asserting the first one
  // unconditionally is a statement about which binary the next launch runs, and
  // it is wrong in the other two cases.
  let installed = false
  let flipped = false
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    const archive = join(staging, `axa-${manifest.version}-${key}.tar.gz`)
    let actual: string
    try {
      actual = await downloadAndHash(platform.url, archive, options?.onProgress)
    } catch (error) {
      // Rethrown with the URL attached. Some transports lose it — a `file://`
      // ENOENT from Bun does, measured — and "which URL" is the first thing
      // anyone asks about a download that failed. Skipped when the message
      // already carries it, which it now does for anything that came through
      // `fetchWithTimeout`: naming the same URL twice in one sentence reads
      // like two different failures.
      const message = (error as Error).message
      throw new Error(
        message.includes(platform.url)
          ? `Could not download: ${message}`
          : `Could not download ${platform.url}: ${message}`,
      )
    }
    const expected = platform.sha256.trim().toLowerCase()

    if (actual !== expected) {
      // Deleted rather than kept for inspection: a file that failed its
      // checksum is the one thing that must not survive to be run by accident.
      rmSync(staging, { recursive: true, force: true })
      const reason = withManifestNotes(
        `Checksum mismatch for ${basename(platform.url)}.\n` +
          `  expected  ${expected}\n` +
          `  actual    ${actual}\n` +
          `The download was discarded and nothing was installed. You are still on ${install.version}.`,
      )
      recordResult({ outcome: 'failed', from: install.version, to: manifest.version, reason })
      return { kind: 'failed', reason }
    }

    const extracted = await extractArchive(archive, staging)
    chmodSync(extracted, 0o755)

    // Run it before anything points at it. A checksum proves the bytes are the
    // ones that were published; it proves nothing about whether they start on
    // this machine — Gatekeeper killing the process, a wrong architecture and a
    // build that was published broken all pass the hash and fail here. The
    // launcher is not moved until the new version has answered.
    await assertBinaryStarts(extracted, manifest.version)

    // Atomic, and on the same filesystem by construction because staging lives
    // under the data dir. Until this line lands there is no such version.
    const target = join(install.versionsDir, manifest.version)
    renameSync(extracted, target)
    installed = true

    // Read before the flip, because after it the launcher points at the new
    // version. This is the version being *replaced*, which is not necessarily
    // the version running this code: a session opened before a previous update
    // is older than what the launcher currently serves, and recording it would
    // send `--rollback` one version further back than the user asked for.
    const replaced = activeVersion(install) ?? install.version

    pointLauncherAt(install, manifest.version)
    flipped = true

    // Written only after the flip: the rollback target is "what was active
    // before", and recording it earlier would leave a pointer to a version that
    // was never replaced if the flip failed.
    // Seeded with whatever the manifest fetch had to say. An update that
    // *succeeded* off a cached manifest is not wrong, but it may have installed
    // a version that is already one behind, and that is worth knowing here too.
    const notes: string[] = [...manifestNotes]
    try {
      writeFileSync(install.previousFile, `${replaced}\n`)
    } catch (error) {
      logError(error)
      // Surfaced, not swallowed. The update itself succeeded, so failing it
      // would be wrong — but `--rollback` reads this file, and a user who is
      // told nothing will find the recovery path quietly not working at the
      // moment they need it. The literal `ln -sfn` line below still works.
      notes.push(
        `Could not record the rollback target in ${install.previousFile}, so ` +
          '`install.sh --rollback` will not know where to go back to.',
      )
    }

    pruneVersions(install, manifest.version, install.version)
    rmSync(staging, { recursive: true, force: true })

    recordResult({
      outcome: 'success',
      from: install.version,
      to: manifest.version,
      channel,
      ...(notes.length > 0 ? { notes } : {}),
    })
    return {
      kind: 'updated',
      from: install.version,
      to: manifest.version,
      ...(notes.length > 0 ? { notes } : {}),
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })

    let state: string
    if (flipped) {
      // Everything that matters already happened; only the bookkeeping after it
      // failed. Saying "nothing was replaced" here would be a flat lie about
      // which binary the next launch runs.
      state =
        `${manifest.version} is installed and \`axa\` now runs it; the step that ` +
        `failed came after that.\n` +
        `To undo: ln -sfn ${join(install.versionsDir, install.version)} ${install.launcher}`
    } else if (installed) {
      state =
        `${join(install.versionsDir, manifest.version)} was written, but the ` +
        `launcher was not repointed — \`axa\` still runs ${install.version}.\n` +
        `To finish by hand: ln -sfn ${join(install.versionsDir, manifest.version)} ${install.launcher}`
    } else {
      state = `Nothing was replaced; you are still on ${install.version}.`
    }

    const reason = withManifestNotes(`${(error as Error).message}\n${state}`)
    recordResult({ outcome: 'failed', from: install.version, to: manifest.version, reason })
    return { kind: 'failed', reason }
  }
}

/** The line to print for an outcome. Kept here so `/update` stays thin. */
export function describeOutcome(
  outcome: UpdateOutcome,
  install: BinaryInstall,
): string {
  switch (outcome.kind) {
    case 'already-latest':
      return (
        `Already on the latest release (${outcome.version}).` +
        (outcome.notes?.length
          ? `\n${outcome.notes.map(n => `Note: ${n}`).join('\n')}`
          : '')
      )
    case 'updated':
      return (
        `Updated ${outcome.from} → ${outcome.to}.\n` +
        'This session keeps running the version it started with — it holds that ' +
        "file's inode, so nothing was corrupted and nothing needs restarting. " +
        'The new version is active the next time you launch `axa`.\n' +
        (outcome.notes?.length
          ? `${outcome.notes.map(n => `Note: ${n}`).join('\n')}\n`
          : '') +
        `If it misbehaves: ln -sfn ${join(install.versionsDir, outcome.from)} ${install.launcher}`
      )
    case 'failed':
      return `Update failed.\n${outcome.reason}`
    case 'not-a-binary-install':
      return 'Not a binary install.'
  }
}
