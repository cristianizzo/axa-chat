import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
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

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
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
// Validate feature flags against known list
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
const buildTime = new Date().toISOString()
const version = dev ? getDevVersion(pkg.version) : pkg.version

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
try {
  // Fails with ENOTEMPTY if a build started while we were sweeping, which is
  // the correct outcome: their marker has to survive.
  rmdirSync(ACTIVE_BUILDS_DIR)
} catch {
  // Another build still holds it.
}

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

emitProgress('build', 100)

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

console.log(`Built ${outfile}`)
