// THIS MODULE RUNS THE BUILD AT IMPORT TIME. It has no main() and no export
// guard: the top-level statements below read argv and write a binary — ./cli
// with no arguments at all, and ./cli-dev, ./dist/cli or ./dist/cli-dev
// depending on --dev and --compile (see the `outfile` assignment). So a bare
// `import('./scripts/build.ts')` is identical to `bun run
// ./scripts/build.ts` — it is NOT a syntax check, and wrapping it in .catch()
// makes a successful build look like a clean one. Someone has already clobbered
// a release artifact this way while trying to verify that an edit parsed.
// To check this file without building, transpile it; do not import it.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { emitProgress, findInstallRoot } from './source.js'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')

/** Read `--flag value` or `--flag=value`, or null when the flag is absent. */
function flagValue(name: string): string | null {
  const inline = args.find(a => a.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1) || null
  const i = args.indexOf(name)
  return i === -1 ? null : (args[i + 1] ?? null)
}

// Staged updates build the new binary beside the live one rather than over it:
// `bun build --outfile` truncates its target in place, which would corrupt the
// running axa binary that started the build. See src/utils/sourceUpdate.ts.
const outfileOverride = flagValue('--outfile')

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BRIDGE_MODE',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

// Tarball installs have no git to ask for the revision, so fall back to the
// commit the installer/updater recorded (see scripts/source.ts). Without this
// every non-git build would be stamped "shaunknown". The marker is searched for
// upwards, since git also answers from any depth and a build run from a
// subdirectory should stamp the same version either way.
function getSourceSha(): string | null {
  return (
    runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ??
    findInstallRoot(process.cwd())?.marker.commit.slice(0, 8) ??
    null
  )
}

/**
 * The build stamps a wall-clock time into the binary twice — `MACRO.BUILD_TIME`,
 * and the date/time inside a dev `MACRO.VERSION`. Both now derive from this one
 * read, so setting `AXA_SOURCE_DATE_EPOCH` (whole seconds since the Unix epoch)
 * makes them stable across builds of the same ref.
 *
 * Same idea as `SOURCE_DATE_EPOCH` and deliberately not that name: we minted
 * this one, so no party outside the repo held the name first and it stays ours
 * to change — unlike the `CLAUDE_*` names, which are read here and set only by
 * someone we cannot update. Note that a wrapper or CI job is the intended
 * setter, so this variable is read in the tree and assigned nowhere in it; that
 * shape is not what makes a name external, prior ownership is.
 *
 * It does NOT make the build reproducible, and that is measured rather than
 * assumed. Two `build:dev:full` runs of one ref with this variable set to the
 * same value — nothing normalised afterwards — still differ by 75,834 bytes.
 * `--bytecode` is the overwhelming majority of that and varies from run to run,
 * so pinning the stamps moves the total around rather than down.
 *
 * Every figure below is a **single pair of builds**, and the run-to-run spread
 * was never measured. Read them as orders of magnitude, not as values, and in
 * particular **do not order them against each other**: an unpinned pair came out
 * at 75,144, which is *smaller* than the pinned 75,834, and that gap (690) is
 * itself smaller than the stamp population it would have to beat to mean
 * anything. Of that unpinned 75,144 the stamps were 460, or 0.6%. With
 * `--bytecode` off, one pair differed by 1,550, of which the stamps were 85
 * (5.5%) — leaving ~1,465 bytes unexplained, which is an observation from one
 * pair and neither a bound nor a mean. Re-measure before treating any of these
 * as a target; a later pair returning 1,600 is the spread, not a regression.
 *
 * Pinning this buys stamp-stability and nothing more.
 */
function resolveBuildDate(): Date {
  const raw = process.env.AXA_SOURCE_DATE_EPOCH
  // Unset and empty both mean "use the wall clock", so a wrapper can pass the
  // variable through unconditionally without having to decide whether to set it.
  if (!raw) return new Date()
  // Reject rather than fall back. A malformed value that quietly degraded to
  // `new Date()` would hand back a build the caller believes is pinned and is
  // not, and that only ever surfaces as an unexplained diff much later.
  if (!/^\d+$/.test(raw)) {
    console.error(
      `\x1b[31m[error]\x1b[0m AXA_SOURCE_DATE_EPOCH must be whole seconds since the Unix epoch, got "${raw}"`,
    )
    process.exit(1)
  }
  const date = new Date(Number(raw) * 1000)
  if (Number.isNaN(date.getTime())) {
    console.error(
      `\x1b[31m[error]\x1b[0m AXA_SOURCE_DATE_EPOCH is out of range for a date: "${raw}"`,
    )
    process.exit(1)
  }
  return date
}

function getDevVersion(baseVersion: string, buildDate: Date): string {
  const timestamp = buildDate.toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = getSourceSha() ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  const log = runCommand(['git', 'log', '--format=%h %s', '-20'])
  if (log) return log
  // No git history available (tarball install): the recorded commit is the only
  // provenance there is.
  const sha = getSourceSha()
  return sha ? `Installed from source tarball at ${sha}` : 'Local development build'
}

const defaultFeatures = ['VOICE_MODE']
const featureSet = new Set(defaultFeatures)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
// Warn on unrecognised feature flags. This does NOT reject them: the flag stays
// in `featureSet` and is passed through to `bun build` below, so an undeclared
// `--feature=X` still takes effect. That is deliberate — it is how you try a flag
// out before adding it to a list, and README documents the invocation — but it
// means this loop is a spell-checker, not a gate. Do not cite it as one when
// arguing a feature is unreachable; a reader has already been misled that way by
// an earlier version of this comment, which said "Validate".
const allKnownFeatures = new Set([...defaultFeatures, ...fullExperimentalFeatures])
for (const f of featureSet) {
  if (!allKnownFeatures.has(f)) {
    console.warn(`\x1b[33m[warn]\x1b[0m Unknown feature flag: "${f}" — check for typos`)
  }
}
const features = [...featureSet]

const outfile =
  outfileOverride ??
  (compile ? (dev ? './dist/cli-dev' : './dist/cli') : dev ? './cli-dev' : './cli')
const buildDate = resolveBuildDate()
const buildTime = buildDate.toISOString()
const version = dev ? getDevVersion(pkg.version, buildDate) : pkg.version

const outDir = dirname(outfile)
if (outDir !== '.') {
  mkdirSync(outDir, { recursive: true })
}

const externals = [
  '@ant/*',
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
]

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/paoloanzn/claude-code',
  ),
} as const

const cmd = [
  'bun',
  'build',
  './src/entrypoints/cli.tsx',
  '--compile',
  '--target',
  'bun',
  '--format',
  'esm',
  '--outfile',
  outfile,
  '--minify',
  '--bytecode',
  '--packages',
  'bundle',
  '--conditions',
  'bun',
]

for (const external of externals) {
  cmd.push('--external', external)
}

for (const feature of features) {
  cmd.push(`--feature=${feature}`)
}

for (const [key, value] of Object.entries(defines)) {
  cmd.push('--define', `${key}=${value}`)
}

/**
 * `bun build --compile` writes a ~61 MB intermediate named
 * `.<hash>-00000000.bun-build` into the working directory and does not remove
 * it, on success or on failure. Left alone it accumulates one per build: this
 * repo had reached 147 files and 8.4 GB before anyone noticed, because
 * `.gitignore` hides them from `git status`.
 */
const TEMP_ARTIFACT_SUFFIX = '.bun-build'

function listTempArtifacts(): string[] {
  return readdirSync(process.cwd()).filter(name =>
    name.endsWith(TEMP_ARTIFACT_SUFFIX),
  )
}

/**
 * Anything older than this was left by a build that died before it could clean
 * up: a build takes seconds, so nothing this old can still be in flight.
 */
const staleBefore = Date.now() - 60 * 60 * 1000

/**
 * Concurrent builds have to announce themselves, because the sweep below
 * cannot otherwise tell our intermediate from theirs — bun names it after a
 * content hash, and every artifact carries the same fabricated `mtime`. Two
 * builds in this directory at once is a real case, not a hypothetical one: a
 * staged self-update runs `bun run update:staged` against `cli-dev.next` in
 * the repo it is updating, which is the same tree a developer builds
 * `cli-dev` from (see src/utils/sourceUpdate.ts).
 *
 * The directory itself is never removed, only the markers inside it. Deleting
 * it would race every other build: one that had just run `mkdirSync` would
 * fail its `writeFileSync`, and one about to scan would fail its `readdirSync`
 * — turning a build that had already succeeded into a crash. An empty hidden
 * directory is the cheaper price.
 */
const ACTIVE_BUILDS_DIR = '.bun-build-active'
const activeMarker = `${ACTIVE_BUILDS_DIR}/${process.pid}`

/** Markers left by builds that were killed; they no longer protect anything. */
function otherActiveBuilds(): number {
  let active = 0
  for (const name of readdirSync(ACTIVE_BUILDS_DIR)) {
    const path = `${ACTIVE_BUILDS_DIR}/${name}`
    try {
      if (statSync(path).ctimeMs > staleBefore) active++
      else rmSync(path, { force: true })
    } catch {
      // Raced with that build's own cleanup; either way it is not active.
    }
  }
  return active
}

mkdirSync(ACTIVE_BUILDS_DIR, { recursive: true })
writeFileSync(activeMarker, '')

// `bun build` reports its own stages but not a percentage, so the build reads
// as two points to a watching parent. It is the shortest of the three stages.
emitProgress('build', 0)

const proc = Bun.spawnSync({
  cmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})

// Runs before the exit check below so a failed build cleans up after itself
// too. With no other build in flight nothing in here is being written, so all
// of it can go; otherwise only the artifacts too old to belong to a live build
// are safe to touch, and ours waits for a quieter build to reap it. `mtime`
// and `birthtime` are useless for that age test — bun clones a template
// binary, so every artifact reports the same fabricated timestamp. `ctime` is
// real.
rmSync(activeMarker, { force: true })
const concurrentBuilds = otherActiveBuilds() > 0
for (const name of listTempArtifacts()) {
  try {
    if (concurrentBuilds && statSync(name).ctimeMs > staleBefore) {
      continue
    }
    rmSync(name, { force: true })
  } catch (error) {
    console.warn(
      `\x1b[33m[warn]\x1b[0m Could not remove build artifact ${name}: ${error}`,
    )
  }
}

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

emitProgress('build', 100)

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

console.log(`Built ${outfile}`)
