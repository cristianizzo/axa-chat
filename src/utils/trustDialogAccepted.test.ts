import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Trust inherits downward: accepting a directory accepts everything under it,
 * which is what makes the dialog a once-per-project question. $HOME is the one
 * directory that must be exempt from that inheritance while still being
 * persistable, because it is simultaneously a legitimate workspace and the
 * ancestor of every other one.
 *
 * Both halves are load-bearing and they fail in opposite directions:
 *  - drop the persistence and the dialog reappears on every launch in ~
 *  - drop the exemption and every directory under ~ is silently trusted,
 *    with no error and nothing on screen to notice
 *
 * These drive checkHasTrustDialogAccepted(), which is the function the tool
 * actually gates on. The git root and homedir() are mocked so the cases can
 * include a git repository rooted at $HOME — the configuration that makes the
 * naive version of this fix fail open — without needing one on disk.
 */

const HOME = '/Users/fixture'
const CHILD_OF_HOME = join(HOME, 'some-untrusted-dir')
const PROJECT = join(HOME, 'Developers', 'a-project')
const NESTED_IN_PROJECT = join(PROJECT, 'src', 'deep')

let gitRoot: string | null = null
let homeValue = HOME

// Both modules are spread rather than replaced: they have other exports that
// the module graph needs, and a bare factory silently drops them.
const actualGit = await import('./git.js')
mock.module('./git.js', () => ({
  ...actualGit,
  findCanonicalGitRoot: () => gitRoot,
}))

// Bun's homedir() ignores $HOME (measured: Node honours it, Bun returns the
// real home), so the fixture home has to be mocked rather than exported.
const actualOs = await import('os')
mock.module('os', () => ({
  ...actualOs,
  homedir: () => homeValue,
}))

// Must be set before config.js is imported: getGlobalClaudeFile() memoizes with
// no resolver, so the first call pins the path for the process. The write-path
// tests below are the only ones that touch disk, and they touch this copy.
const configScratch = mkdtempSync(join(realpathSync(tmpdir()), 'trust-config-'))
process.env.CLAUDE_CONFIG_DIR = configScratch

const { getGlobalClaudeFile } = await import('./env.js')
const { setOriginalCwd } = await import('../bootstrap/state.js')
const { runWithCwdOverride } = await import('./cwd.js')
const {
  _setGlobalConfigCacheForTesting,
  acceptTrustForCurrentWorkspace,
  checkHasTrustDialogAccepted,
  enableConfigs,
  getProjectPathForConfig,
  resetHomeConfigKeysCacheForTesting,
  resetTrustDialogAcceptedCacheForTesting,
  saveGlobalConfig,
} = await import('./config.js')

// Under NODE_ENV=test saveGlobalConfig only mutates an in-memory object, so
// the real ~/.claude/config.json is never read or written.
const setTrustedPaths = (paths: string[]) =>
  saveGlobalConfig(config => ({
    ...config,
    projects: Object.fromEntries(
      paths.map(p => [
        p,
        {
          // The three required fields of ProjectConfig; none is read here, but
          // spelling them out keeps the fixture a real ProjectConfig rather
          // than a cast.
          allowedTools: [],
          mcpContextUris: [],
          projectOnboardingSeenCount: 0,
          hasTrustDialogAccepted: true,
        },
      ]),
    ),
  }))

/**
 * Evaluate the trust check as if the session had started in `dir`.
 * getProjectPathForConfig is memoized process-wide and the trust result
 * latches, so both have to be cleared between directories.
 */
const trustedIn = (
  dir: string,
  root: string | null = null,
  cwd: string = dir,
): boolean => {
  gitRoot = root
  setOriginalCwd(dir)
  getProjectPathForConfig.cache.clear?.()
  resetHomeConfigKeysCacheForTesting()
  resetTrustDialogAcceptedCacheForTesting()
  return runWithCwdOverride(cwd, () => checkHasTrustDialogAccepted())
}

beforeEach(() => {
  setTrustedPaths([])
  homeValue = HOME
})

test('an untrusted directory is not trusted', () => {
  expect(trustedIn(PROJECT)).toBe(false)
})

test('a directory trusted by exact path is trusted', () => {
  setTrustedPaths([PROJECT])

  expect(trustedIn(PROJECT)).toBe(true)
})

test('trust inherits from an ancestor project to its subdirectories', () => {
  setTrustedPaths([PROJECT])

  expect(trustedIn(NESTED_IN_PROJECT)).toBe(true)
})

test('$HOME is trusted when $HOME is the directory being checked', () => {
  setTrustedPaths([HOME])

  expect(trustedIn(HOME)).toBe(true)
})

/**
 * The reason $HOME trust was session-only upstream. If this regresses, the
 * dialog stops being asked for every project the user ever creates, and
 * nothing fails visibly.
 */
test('$HOME trust does not inherit to a directory beneath it', () => {
  setTrustedPaths([HOME])

  expect(trustedIn(CHILD_OF_HOME)).toBe(false)
  expect(trustedIn(NESTED_IN_PROJECT)).toBe(false)
})

test('a directory under a trusted $HOME can still be trusted on its own', () => {
  setTrustedPaths([HOME, PROJECT])

  expect(trustedIn(NESTED_IN_PROJECT)).toBe(true)
  // ...and the exemption is still in force for everything else.
  expect(trustedIn(CHILD_OF_HOME)).toBe(false)
})

/**
 * The exemption is keyed on $HOME specifically, not on "the first ancestor
 * found", so an intermediate trusted directory must still inherit normally
 * even with $HOME trusted above it.
 */
test('a non-home ancestor still inherits with $HOME trusted above it', () => {
  setTrustedPaths([HOME, join(HOME, 'Developers')])

  expect(trustedIn(PROJECT)).toBe(true)
})

/**
 * `git init ~` for dotfiles. getProjectPathForConfig() returns the git root,
 * and that lookup happens before the ancestor walk — so without the exemption
 * applied there too, one acceptance in ~ trusts every directory under home
 * and the walk never even runs.
 */
test('a git repository rooted at $HOME does not trust its subdirectories', () => {
  setTrustedPaths([HOME])

  expect(trustedIn(PROJECT, HOME)).toBe(false)
})

/**
 * The early getTrustPathForConfig() lookup runs before the ancestor walk and
 * keys off getOriginalCwd(), while the walk keys off getCwd(). They diverge in
 * production (EnterWorktreeTool moves cwd mid-session), so a case where they
 * differ is the only thing that reaches that branch at all.
 */
test('the workspace stays trusted after cwd moves away from it', () => {
  setTrustedPaths([PROJECT])

  expect(trustedIn(PROJECT, null, '/tmp/somewhere-else')).toBe(true)
})

/**
 * homedir() is not NFC-normalised and getOriginalCwd() is, so an accented
 * username arrives spelled two ways. Same fail-open class as the symlink case.
 */
test('a decomposed (NFD) home spelling still matches the config key', () => {
  const composed = '/Users/jose\u0301'.normalize('NFC')
  homeValue = composed.normalize('NFD')
  setTrustedPaths([composed])

  expect(trustedIn(join(composed, 'a-project'))).toBe(false)
})

/**
 * resolve('') returns the current working directory, so an empty home would
 * silently exempt cwd and let the real $HOME entry inherit freely.
 */
test('an empty homedir() exempts nothing', () => {
  // resolve('') is the *process* cwd, so without the guard the exemption
  // silently re-anchors onto whatever directory the tool happens to be run
  // from — which is why the fixture here has to be that directory.
  const processCwd = process.cwd()
  homeValue = ''
  setTrustedPaths([processCwd])

  expect(trustedIn(join(processCwd, 'a-project'))).toBe(true)
})

test('$HOME itself is still trusted when it is a git root', () => {
  setTrustedPaths([HOME])

  expect(trustedIn(HOME, HOME)).toBe(true)
})

/**
 * The write side. Under NODE_ENV=test every project write is folded into one
 * path-less in-memory object, so *which key* trust lands on is structurally
 * unobservable — and that key is the whole point of getTrustPathForConfig().
 * These two drop out of test mode for the duration of the call and read the
 * config back off disk, in a temp CLAUDE_CONFIG_DIR.
 *
 * NODE_ENV is restored in a finally: `bun test` runs every file in one
 * process, so leaking the deletion breaks the rest of the suite.
 */
const acceptTrustFrom = (
  dir: string,
  root: string | null = null,
): Record<string, { hasTrustDialogAccepted?: boolean }> => {
  gitRoot = root
  setOriginalCwd(dir)
  getProjectPathForConfig.cache.clear?.()
  resetHomeConfigKeysCacheForTesting()
  resetTrustDialogAcceptedCacheForTesting()

  const previousNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    enableConfigs()
    // Each case asserts on the whole set of trusted keys, so it has to start
    // from an empty one rather than inherit the previous case's write.
    rmSync(getGlobalClaudeFile(), { force: true })
    _setGlobalConfigCacheForTesting(null)
    runWithCwdOverride(dir, () => acceptTrustForCurrentWorkspace())
  } finally {
    process.env.NODE_ENV = previousNodeEnv
  }

  return JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8')).projects ?? {}
}

const trustedKeys = (projects: Record<string, { hasTrustDialogAccepted?: boolean }>) =>
  Object.keys(projects).filter(k => projects[k]?.hasTrustDialogAccepted)

test('accepting trust persists it under the git root', () => {
  const projects = acceptTrustFrom(NESTED_IN_PROJECT, PROJECT)

  expect(trustedKeys(projects)).toEqual([PROJECT])
})

test('accepting trust in $HOME persists it under $HOME', () => {
  const projects = acceptTrustFrom(HOME)

  expect(trustedKeys(projects)).toEqual([HOME])
})

/**
 * The half that would otherwise loop forever: inside a repo rooted at $HOME,
 * trust must land on the working directory, because a $HOME key is exactly
 * what the read side refuses to inherit from.
 */
test('trust inside a home-rooted repo is persisted under cwd, not $HOME', () => {
  const projects = acceptTrustFrom(PROJECT, HOME)

  expect(trustedKeys(projects)).toEqual([PROJECT])
})

/**
 * homedir() returns the passwd entry unresolved, while the config key is
 * canonicalised — getOriginalCwd() applies NFC and git roots are realpathed.
 * So on any layout where the home path traverses a symlink (/home -> /var/home
 * on Silverblue, NFS and autofs homes, containers) the two spellings differ,
 * and an exemption that matches only the raw value is inert from first launch
 * with nothing to indicate it. A real symlink is used here because the
 * behaviour under test is realpath resolution.
 */
const symlinkScratch = mkdtempSync(join(realpathSync(tmpdir()), 'trust-home-'))
afterAll(() => {
  rmSync(symlinkScratch, { recursive: true, force: true })
  rmSync(configScratch, { recursive: true, force: true })
})

test('a home reached through a symlink is still recognised as $HOME', () => {
  const realHome = join(symlinkScratch, 'real-home')
  const linkedHome = join(symlinkScratch, 'linked-home')
  mkdirSync(realHome)
  symlinkSync(realHome, linkedHome)

  // The user's passwd entry points at the symlink...
  homeValue = linkedHome
  // ...but trust was persisted under the canonical path.
  setTrustedPaths([realHome])

  expect(trustedIn(join(realHome, 'a-project'))).toBe(false)
  // The canonical home itself is still trusted when it is the workspace.
  expect(trustedIn(realHome)).toBe(true)
})
