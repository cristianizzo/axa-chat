import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { homedir, tmpdir } from 'os'
import { join, normalize, parse, posix, sep } from 'path'
import {
  getAutoMemPath,
  getMemoryBaseDir,
  hasAutoMemPathOverride,
  isAutoMemPath,
} from 'src/memdir/paths.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import {
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
  LEGACY_PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN,
  PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN,
} from 'src/tools/FileEditTool/constants.js'
import type { z } from 'zod/v4'
import {
  getFlagMcpConfigPaths,
  getOriginalCwd,
  getSessionId,
} from '../../bootstrap/state.js'
import { isGlobalConfigFileName } from '../../constants/oauth.js'
import { CONFIG_DIR_NAME, MEMORY_FILE_NAME } from '../../constants/product.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { AnyObject, Tool, ToolPermissionContext } from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { getCwd } from '../cwd.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../fsOperations.js'
import {
  containsPathTraversal,
  expandPath,
  getDirectoryForPath,
  sanitizePath,
} from '../path.js'
import { getPlanSlug, getPlansDirectory } from '../plans.js'
import { getPlatform } from '../platform.js'
import { getProjectDir } from '../sessionStorage.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsRootPathForSource,
} from '../settings/settings.js'
import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import { getToolResultsDir } from '../toolResultStorage.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type {
  PermissionDecision,
  PermissionResult,
} from './PermissionResult.js'
import type { PermissionRule, PermissionRuleSource } from './PermissionRule.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'
import type { PermissionUpdate } from './PermissionUpdateSchema.js'
import { getRuleByContentsForToolName } from './permissions.js'

declare const MACRO: { VERSION: string }

/**
 * Dangerous files that should be protected from auto-editing.
 * These files can be used for code execution or data exfiltration.
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  // NOT legacy naming — a `.claude` sweep matches this line and reads it as
  // drift from the rename, which is the opposite of what it is. `~/.claude.json`
  // is the live global config of a *real, current* Claude Code install: another
  // product's session state, not a pre-rename spelling of anything this fork
  // owns. A write there corrupts that install's session and forces a re-login,
  // and it is just as hazardous on a machine that never had a legacy config dir.
  // Nothing in this repo may write this file; for auto-editing, this entry is
  // what enforces that. Stored bare because the check compares it against the
  // **last** path segment only (`pathSegments.at(-1)`) — not against every
  // segment, which an earlier wording of this line ("basename anywhere in the
  // path") wrongly implied. Nothing is lost by that: the entry names a file, so
  // the only path it needs to catch is one ending in it. Contrast
  // DANGEROUS_DIRECTORIES, which really does scan every segment — see the loop
  // over `pathSegments` in `isDangerousFilePathToAutoEdit`, where both lists are
  // consumed — because a directory has to be caught with children beneath it.
  //
  // Polarity, because the `.claude` handling in this file runs both ways and
  // inspection cannot tell them apart: this is a denylist **entry**, so deleting
  // it *under-blocks* — protection silently gone, no code path breaks, nothing
  // fails a typecheck. `.claude` in DANGEROUS_DIRECTORIES is an entry too, but
  // `.claude` in the worktree-path check below is an *exemption from* that
  // denylist, and deleting that one over-blocks instead. Ask "does removing this
  // under-block or over-block?", never "is this literal deliberate?".
  '.claude.json',
] as const

/**
 * Dangerous directories that should be protected from auto-editing.
 * These directories contain sensitive configuration or executable files.
 */
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  CONFIG_DIR_NAME,
  // Legacy, and deliberately still listed. A project that has not been
  // migrated still keeps live config here, so dropping it would remove this
  // protection from exactly the projects that predate the rename — the ones
  // still relying on it.
  '.claude',
  // Credential / persistence directories. Writing here grants persistent
  // access or exposes secrets: an edit to ~/.ssh/authorized_keys is a
  // backdoor, and these hold private keys / cloud credentials. Listed as
  // whole directories because every file under them is sensitive. The
  // segment match applies wherever they appear (home or a project's .ssh).
  '.ssh',
  '.aws',
  '.gnupg',
] as const

/**
 * Every config-folder spelling a session-scoped allow rule may be scoped to,
 * checked by step 1.6 of checkWritePermissionForTool. Three entries, not two:
 * the project scope is `.axa` in this fork, but `.claude` stays in
 * DANGEROUS_DIRECTORIES for projects that predate the rename, so both project
 * spellings need a way through.
 */
const CONFIG_FOLDER_PERMISSION_PATTERNS = [
  PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN,
  LEGACY_PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
] as const

/**
 * Every separator spelling a caller may have used between a root and the rest
 * of a path. Windows accepts both, POSIX only its own, so this is a `Set` of
 * **size 2 on Windows and size 1 on POSIX** — deduped rather than written as a
 * two-element literal precisely so the POSIX case does not test `'/'` twice.
 *
 * Hoisted because the two root-prefix loops that consume it
 * (`relativeToConfigDirRoot` and `foldResolvedRootPrefix`) build it once per
 * candidate root *form*, not once per call. Be exact about what that saves: it
 * removes an **allocation**, not a comparison. The number of `startsWith` tests
 * is unchanged, and on POSIX it was always 1 — so do not read this as making
 * the loops cheaper in the sense that matters for the O(N) chain-walk cost
 * discussed at `allowOnlyIfResolvedFormsAgree`. Different quantity.
 *
 * `sep` is a module-scope import, so evaluating this at module scope is
 * deterministic; it does not depend on session or platform state that could
 * change after load.
 *
 * The two consumers now share this constant, which is convenient and is *not*
 * progress on their divergence: they disagree about how the **roots** are
 * built, not about how separators are spelled. Sharing this does not close that
 * gap and must not be cited as if it had.
 */
const ROOT_SEPARATOR_SPELLINGS: ReadonlySet<string> = new Set([sep, '/'])

/**
 * Does `p` already end in one of ROOT_SEPARATOR_SPELLINGS?
 *
 * Both root-prefix loops below test `rootLower + s` for each spelling `s`, which
 * assumes the root form carries no trailing separator. That assumption is false
 * for exactly one population, and it is one the roots are *deliberately* allowed
 * to be in: `stripTrailingSeparatorsForWalk` returns a root-only spelling
 * unchanged, because stripping `C:\` to `C:` changes what the string denotes.
 * `rootLower + s` is then a doubled separator (`//`, `C:\\`), which no
 * normalized path can start with, so every path under such a root stops
 * matching. Hence the branch at both call sites: when the root form already ends
 * in a separator the component boundary is present, so the prefix test is the
 * bare root and the remainder starts at `rootForm.length`.
 *
 * Measured with `path.posix` / `path.win32` over a 23-root sweep run through the
 * real pipeline (`stripTrailingSeparatorsForWalk` -> `normalize`, plus the fold
 * site's further `stripTrailingSeparators`), covering `/`, `C:\`, `C://`,
 * `\\server\share\`, `\\?\C:\` and their redundant spellings alongside ordinary
 * `/cfg/` and `C:\cfg\` controls:
 *
 *                                              classify        fold
 *   root forms reaching the loop with a
 *     trailing separator                       posix 3         posix 3
 *                                              win32 15        win32 5
 *   of those, forms that are NOT root-only     0 on both       0 on both
 *
 * The second row is what makes the bare-prefix test safe — the trailing
 * separator *is* the boundary — and the first row is the control that keeps the
 * zero from being a dead instrument.
 *
 * The two loops do not share a population, so do not carry one reachability
 * sentence across them. `relativeToConfigDirRoot` matches against
 * `getResolvedConfigDirRoots`, which only normalizes, so it sees drive, share
 * and extended-length roots as well as `/`. `foldResolvedRootPrefix` matches
 * against `getFoldableRootsForSession`, which strips its forms afterwards, and
 * `stripTrailingSeparators` reduces `C:\` to `C:` and `\\server\share\` to
 * `\\server\share`; only the all-separator root survives its empty-string guard,
 * so the fold's population is `/` on posix and `\` on win32 and nothing else.
 *
 * **Say out loud what the bare prefix test does when the root is `/`, because
 * the sentence above understates it.** For every other member of this
 * population the root is a drive, a share or an extended-length prefix and the
 * bare test still selects a bounded subtree. For `/` it selects *everything*:
 * `pathLower.startsWith('/')` is true of every absolute POSIX path, so a
 * session with `CLAUDE_CONFIG_DIR=/` stops returning `null` from
 * `relativeToConfigDirRoot` for any path at all, and every file on the machine
 * arrives at `classifyConfigDirRelativePath`. That is a real behaviour change
 * and it should be read deliberately rather than discovered.
 *
 * It grants nothing new, and the reason is worth writing down because "it is
 * fine" is not checkable and this is:
 *
 *  - The **write** grant at the `=== 'open'` call site needs `'open'`, and
 *    `classifyConfigDirRelativePath` **defaults to `'protected'`**. Reaching
 *    `'open'` needs the first segment in `CONFIG_DIR_OPEN_DIRS`, so under a `/`
 *    root the widened population is `/plans`, `/agent-memory`,
 *    `/agent-memory-local`, `/magic-docs` and `/rules` — not `/etc`, `/usr` or
 *    `/home`, which take the protected default.
 *  - The **read** grant needs `'open'`, or `'protected'` *and*
 *    `isReadableConfigDirPath`, which independently requires the first segment
 *    in `CONFIG_DIR_READABLE_DIRS`. `/etc/passwd` classifies `'protected'` and
 *    fails that second test, so it gets neither grant.
 *  - `/` is not reachable by accident. It is a config *home*, and the only way
 *    it becomes one is the user setting `CLAUDE_CONFIG_DIR=/` — at which point
 *    treating `/plans` as their plans directory is the literal meaning of what
 *    they asked for, not something this branch invented.
 *
 * Note the direction: before this branch a `/` root matched **nothing**,
 * because `rootLower + s` was `//` and no normalized path starts with it. So
 * the carve-outs a `CLAUDE_CONFIG_DIR=/` user configured silently did not work.
 * This is a fix for that, not a widening past it — but the two are easy to
 * confuse from the diff alone, which is why it is stated here.
 */
function endsWithSeparatorSpelling(p: string): boolean {
  for (const s of ROOT_SEPARATOR_SPELLINGS) {
    if (p.endsWith(s)) return true
  }
  return false
}

/**
 * Normalizes a path for case-insensitive comparison.
 * This prevents bypassing security checks using mixed-case paths on case-insensitive
 * filesystems (macOS/Windows) like `.cLauDe/Settings.locaL.json`.
 *
 * We always normalize to lowercase regardless of platform for consistent security.
 * @param path The path to normalize
 * @returns The lowercase path for safe comparison
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

/**
 * If filePath is inside a {CONFIG_DIR_NAME}/skills/{name}/ directory (project
 * or global), return the skill name and a session-allow pattern scoped to just
 * that skill. Used to offer a narrower "allow edits to this skill only" option
 * in the permission dialog and SDK suggestions, so iterating on one skill
 * doesn't require granting session access to all of {CONFIG_DIR_NAME}/
 * (settings.json, hooks/, etc.).
 */
export function getClaudeSkillScope(
  filePath: string,
): { skillName: string; pattern: string } | null {
  const absolutePath = expandPath(filePath)
  const absolutePathLower = normalizeCaseForComparison(absolutePath)

  const bases = [
    {
      dir: expandPath(join(getOriginalCwd(), CONFIG_DIR_NAME, 'skills')),
      prefix: `/${CONFIG_DIR_NAME}/skills/`,
    },
    {
      // Our config dir, not `~/.claude` — personal skills load from
      // getClaudeConfigHomeDir()/skills (loadSkillsDir.ts:640), so the upstream
      // name would make this scope match nothing.
      //
      // Built from homedir() rather than getClaudeConfigHomeDir() so `dir` and
      // `prefix` cannot disagree when CLAUDE_CONFIG_DIR is set: `prefix` has to
      // stay in tilde form to satisfy the
      // GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN check that gates the resulting
      // rule, and a pattern that check rejects would be a dead suggestion.
      dir: expandPath(join(homedir(), CONFIG_DIR_NAME, 'skills')),
      prefix: `~/${CONFIG_DIR_NAME}/skills/`,
    },
  ]

  for (const { dir, prefix } of bases) {
    const dirLower = normalizeCaseForComparison(dir)
    // Try both path separators (Windows paths may not be normalized to /)
    for (const s of [sep, '/']) {
      if (absolutePathLower.startsWith(dirLower + s.toLowerCase())) {
        // Match on lowercase, but slice the ORIGINAL path so the skill name
        // preserves case (pattern matching downstream is case-sensitive)
        const rest = absolutePath.slice(dir.length + s.length)
        const slash = rest.indexOf('/')
        const bslash = sep === '\\' ? rest.indexOf('\\') : -1
        const cut =
          slash === -1
            ? bslash
            : bslash === -1
              ? slash
              : Math.min(slash, bslash)
        // Require a separator: file must be INSIDE the skill dir, not a
        // file directly under skills/ (no skill scope for that)
        if (cut <= 0) return null
        const skillName = rest.slice(0, cut)
        // Reject traversal and empty. Use includes('..') not === '..' to
        // match step 1.6's ruleContent.includes('..') guard: a skillName like
        // 'v2..beta' would otherwise produce a suggestion step 1.7 emits but
        // step 1.6 always rejects (dead suggestion, infinite re-prompt).
        if (!skillName || skillName === '.' || skillName.includes('..')) {
          return null
        }
        // Reject glob metacharacters. skillName is interpolated into a
        // gitignore pattern consumed by ignore().add() in matchingRuleForInput
        // at step 1.6. A directory literally named '*' (valid on POSIX) would
        // produce '/.axa/skills/*/**' which matches ALL skills. Return null
        // to fall through to generateSuggestions() instead.
        if (/[*?[\]]/.test(skillName)) return null
        return { skillName, pattern: prefix + skillName + '/**' }
      }
    }
  }

  return null
}

// Always use / as the path separator per gitignore spec
// https://git-scm.com/docs/gitignore
const DIR_SEP = posix.sep

/**
 * Cross-platform relative path calculation that returns POSIX-style paths.
 * Handles Windows path conversion internally.
 * @param from The base path
 * @param to The target path
 * @returns A POSIX-style relative path
 */
export function relativePath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    // Convert Windows paths to POSIX for consistent comparison
    const posixFrom = windowsPathToPosixPath(from)
    const posixTo = windowsPathToPosixPath(to)
    return posix.relative(posixFrom, posixTo)
  }
  // Use POSIX paths directly
  return posix.relative(from, to)
}

/**
 * Converts a path to POSIX format for pattern matching.
 * Handles Windows path conversion internally.
 * @param path The path to convert
 * @returns A POSIX-style path
 */
export function toPosixPath(path: string): string {
  if (getPlatform() === 'windows') {
    return windowsPathToPosixPath(path)
  }
  return path
}

function getSettingsPaths(): string[] {
  return SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter(path => path !== undefined)
}

export function isClaudeSettingsPath(filePath: string): boolean {
  // SECURITY: Normalize path structure first to prevent bypass via redundant ./
  // sequences like `./.claude/./settings.json` which would evade the endsWith() check
  const expandedPath = expandPath(filePath)

  // Normalize for case-insensitive comparison to prevent bypassing security
  // with paths like .cLauDe/Settings.locaL.json
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  // Match a settings file in *any* project's config dir, not just this
  // session's. getSettingsPaths() below covers only the current session, so
  // without this arm a foreign project's settings.json is unprotected — and
  // that is the case this arm exists for.
  //
  // `.axa` is built from CONFIG_DIR_NAME so the canonical spelling has one
  // definition. The legacy spelling stays a literal on purpose: it is not the
  // config dir this product writes, it is a foreign directory this predicate
  // still refuses to auto-edit, and LEGACY_CONFIG_DIR_NAME documents itself as
  // read in exactly one place (the startup import check). Reaching for it here
  // would make that constant's docblock false to save one string.
  //
  // Use platform separator so endsWith checks work on both Unix (/) and Windows (\)
  const isSettingsFileUnder = (configDirName: string): boolean =>
    normalizedPath.endsWith(`${sep}${configDirName}${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}${configDirName}${sep}settings.local.json`)
  if (isSettingsFileUnder(CONFIG_DIR_NAME) || isSettingsFileUnder('.claude')) {
    return true
  }
  // Check for current project's settings files (including managed settings and CLI args)
  // Both paths are now absolute and normalized for consistent comparison
  return getSettingsPaths().some(
    settingsPath => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

// Always ask when Claude Code tries to edit its own config files
function isClaudeConfigFilePath(filePath: string): boolean {
  if (isClaudeSettingsPath(filePath)) {
    return true
  }

  // Check if file is within {CONFIG_DIR_NAME}/commands, agents or skills using
  // proper path segment validation (not string matching with includes())
  // pathInWorkingPath now handles case-insensitive comparison to prevent bypasses
  const commandsDir = join(getOriginalCwd(), CONFIG_DIR_NAME, 'commands')
  const agentsDir = join(getOriginalCwd(), CONFIG_DIR_NAME, 'agents')
  const skillsDir = join(getOriginalCwd(), CONFIG_DIR_NAME, 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

// Check if file is the plan file for the current session
function isSessionPlanFile(absolutePath: string): boolean {
  // Check if path is a plan file for this session (main or agent-specific)
  // Main plan file: {plansDir}/{planSlug}.md
  // Agent plan file: {plansDir}/{planSlug}-agent-{agentId}.md
  const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath.startsWith(expectedPrefix) && normalizedPath.endsWith('.md')
  )
}

/**
 * Returns the session memory directory path for the current session with trailing separator.
 * Path format: {projectDir}/{sessionId}/session-memory/
 */
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

/**
 * Returns the session memory file path for the current session.
 * Path format: {projectDir}/{sessionId}/session-memory/summary.md
 */
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}

// Check if file is within the session memory directory
function isSessionMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getSessionMemoryDir())
}

/**
 * Check if file is within the current project's directory.
 * Path format: ~/.claude/projects/{sanitized-cwd}/...
 */
function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
  )
}

/**
 * Checks if the scratchpad directory feature is enabled.
 * The scratchpad is a per-session directory for Claude to write temporary files.
 * Controlled by the tengu_scratch Statsig gate.
 */
export function isScratchpadEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}

/**
 * Returns the user-specific Claude temp directory name.
 * On Unix: 'claude-{uid}' to prevent multi-user permission conflicts
 * On Windows: 'claude' (tmpdir() is already per-user)
 */
export function getClaudeTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'claude'
  }
  // Use UID to create per-user directories, preventing permission conflicts
  // when multiple users share the same /tmp directory
  const uid = process.getuid?.() ?? 0
  return `claude-${uid}`
}

/**
 * Returns the Claude temp directory path with symlinks resolved **in its base
 * only**, and with a trailing separator.
 *
 * The distinction is load-bearing and this docblock used to elide it. Only
 * `baseTmpDir` is realpath'd; `claude-{uid}` is then appended with a plain
 * `join` and never resolved. So if that tail component is itself a symlink,
 * every path built on this root is lexical from there down, exactly like
 * `getClaudeConfigHomeDir()` — and a permission check that compares a *resolved*
 * candidate against this root will not match. That is why this root is folded
 * in `getFoldableRootsForSession` rather than trusted as canonical, and callers
 * that need a fully canonical path must resolve it themselves.
 *
 * Uses TMPDIR env var if set, otherwise:
 * - On Unix: /tmp/claude-{uid}/ (resolved to /private/tmp/claude-{uid}/ on macOS)
 * - On Windows: {tmpdir}/claude/ (e.g., C:\Users\{user}\AppData\Local\Temp\claude\)
 * This is a per-user temporary directory used by Claude Code for all temp files.
 *
 * NOTE: the base is resolved so that this path matches the resolved paths used
 * in permission checks. On macOS, /tmp is a symlink to /private/tmp, so without
 * resolution, paths like /tmp/claude-{uid}/... wouldn't match /private/tmp/claude-{uid}/...
 * That reasoning is correct for `/tmp` and does *not* extend to the
 * `claude-{uid}` component, which is the whole of the caveat above.
 */
// Memoized: called per-tool from permission checks (yoloClassifier, sandbox-adapter)
// and per-turn from BashTool prompt. Inputs (CLAUDE_CODE_TMPDIR env + platform) are
// fixed at startup, and the realpath of the system tmp dir does not change mid-session.
export const getClaudeTempDir = memoize(function getClaudeTempDir(): string {
  const baseTmpDir =
    process.env.CLAUDE_CODE_TMPDIR ||
    (getPlatform() === 'windows' ? tmpdir() : '/tmp')

  // Resolve symlinks in the base temp directory (e.g., /tmp -> /private/tmp on macOS)
  // This ensures the path matches resolved paths in permission checks
  const fs = getFsImplementation()
  let resolvedBaseTmpDir = baseTmpDir
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // If resolution fails, use the original path
  }

  return join(resolvedBaseTmpDir, getClaudeTempDirName()) + sep
})

/**
 * Root for bundled-skill file extraction (see bundledSkills.ts).
 *
 * SECURITY: The per-process random nonce is the load-bearing defense here.
 * Every other path component (uid, VERSION, skill name, file keys) is public
 * knowledge, so without it a local attacker can pre-create the tree on a
 * shared /tmp — sticky bit prevents deletion, not creation — and either
 * symlink an intermediate directory (O_NOFOLLOW only checks the final
 * component) or own a parent dir and swap file contents post-write for prompt
 * injection via the read allowlist. diskOutput.ts gets the same property from
 * the session-ID UUID in its path.
 *
 * Memoized so the extraction writes and the permission check agree on the
 * path for the life of the process. Version-scoped so stale extractions from
 * other binaries don't fall under the allowlist.
 */
export const getBundledSkillsRoot = memoize(
  function getBundledSkillsRoot(): string {
    const nonce = randomBytes(16).toString('hex')
    return join(getClaudeTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
  },
)

/**
 * Returns the project temp directory path with trailing separator.
 * Path format: /tmp/claude-{uid}/{sanitized-cwd}/
 */
export function getProjectTempDir(): string {
  return join(getClaudeTempDir(), sanitizePath(getOriginalCwd())) + sep
}

/**
 * Returns the scratchpad directory path for the current session, with **no**
 * trailing separator.
 * Path format: /tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/scratchpad
 *
 * The neighbour above is the trap. `getProjectTempDir` genuinely does end in
 * `sep` and its docblock correctly says so; this one is built from it, the `/`
 * was carried down with the rest of the line, and `join` then dropped it. Two
 * adjacent near-identical docblocks, only one of them true — which is what
 * makes "make the code match the doc" the natural-looking fix here.
 *
 * It is the wrong fix. `isScratchpadPath` below tests
 * `normalized === scratchpadDir` or `normalized.startsWith(scratchpadDir + sep)`,
 * and appending a separator here kills both branches for every input that
 * actually arrives: measured, a trailing-separator root returns false for the
 * directory itself, for `…/scratchpad/file.txt` and for
 * `…/scratchpad/sub/file.txt`, all three of which the shipped shape returns
 * true for. `normalize` does not rescue it, and not for the reason usually
 * given — it *preserves* a trailing separator rather than stripping one, so
 * the sole surviving match would be the directory spelled with a trailing
 * slash, which nothing here produces.
 *
 * The failure would be closed and silent: the scratchpad carve-out stops
 * applying, writes are refused, and there is no error and no log to read.
 */
export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

/**
 * Ensures the scratchpad directory exists for the current session.
 * Creates the directory with secure permissions (0o700) if it doesn't exist.
 * Returns the path to the scratchpad directory.
 * @throws If scratchpad feature is not enabled
 */
export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()

  // Create directory recursively with secure permissions (owner-only access)
  // FsOperations.mkdir handles recursive: true internally and is a no-op if dir exists
  await fs.mkdir(scratchpadDir, { mode: 0o700 })

  return scratchpadDir
}

// Check if file is within the scratchpad directory
function isScratchpadPath(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  // SECURITY: Normalize the path to resolve .. segments before checking
  // This prevents path traversal bypasses like:
  //   echo "malicious" > /tmp/claude-0/proj/session/scratchpad/../../../etc/passwd
  // Without normalization, the path would pass the startsWith check but write to /etc/passwd
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === scratchpadDir ||
    normalizedPath.startsWith(scratchpadDir + sep)
  )
}

/**
 * Check if a file path is dangerous to auto-edit without explicit permission.
 * This includes:
 * - Files in .git directories or .gitconfig files (to prevent git-based data exfiltration and code execution)
 * - Files in .vscode directories (to prevent VS Code settings manipulation and potential code execution)
 * - Files in .idea directories (to prevent JetBrains IDE settings manipulation)
 * - Shell configuration files (to prevent shell startup script manipulation)
 * - UNC paths (to prevent network file access and WebDAV attacks)
 */
function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // Check for UNC paths (defense-in-depth to catch any patterns that might not be caught by containsVulnerableUncPath)
  // Block anything starting with \\ or // as these are potentially UNC paths that could access network resources
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // Check if path is within dangerous directories (case-insensitive to prevent bypasses)
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // Special case: <config>/worktrees/ is a structural path (where axa
      // stores git worktrees), not a user-created dangerous directory. Skip the
      // config segment when it's followed by 'worktrees'. Any nested config
      // directories within the worktree (not followed by 'worktrees') are still
      // blocked. Both spellings, since an unmigrated project still has its
      // worktrees under the legacy name.
      if (dir === CONFIG_DIR_NAME || dir === '.claude') {
        const nextSegment = pathSegments[i + 1]
        if (
          nextSegment &&
          normalizeCaseForComparison(nextSegment) === 'worktrees'
        ) {
          break // Skip this .claude, continue checking other segments
        }
      }

      return true
    }
  }

  // Check for dangerous configuration files (case-insensitive)
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        dangerousFile =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * Detects suspicious Windows path patterns that could bypass security checks.
 * These patterns include:
 * - NTFS Alternate Data Streams (e.g., file.txt::$DATA or file.txt:stream)
 * - 8.3 short names (e.g., GIT~1, CLAUDE~1, SETTIN~1.JSON)
 * - Long path prefixes (e.g., \\?\C:\..., \\.\C:\..., //?/C:/..., //./C:/...)
 * - Trailing dots and spaces (e.g., .git., .claude , .bashrc...)
 * - DOS device names (e.g., .git.CON, settings.json.PRN, .bashrc.AUX)
 * - Three or more consecutive dots (e.g., .../file.txt, path/.../file, file...txt)
 *
 * When detected, these paths should always require manual approval to prevent
 * bypassing security checks through path canonicalization vulnerabilities.
 *
 * ## Why Check on All Platforms?
 *
 * While these patterns are primarily Windows-specific, NTFS filesystems can be
 * mounted on Linux and macOS (e.g., using ntfs-3g). On these systems, the same
 * bypass techniques would work - an attacker could use short names or long path
 * prefixes to bypass security checks. Therefore, we check for these patterns on
 * all platforms to ensure comprehensive protection. (Note: the ADS colon check
 * is Windows/WSL-only, since colon syntax is only interpreted by the Windows
 * kernel; on Linux/macOS, NTFS ADS is accessed via xattrs, not colon syntax.)
 *
 * ## Why Detection Instead of Normalization?
 *
 * An alternative approach would be to normalize these paths using Windows APIs
 * (e.g., GetLongPathNameW). However, this approach has significant challenges:
 *
 * 1. **Filesystem dependency**: Short path normalization is relative to files that
 *    currently exist on the filesystem. This creates issues when writing to new
 *    files since they don't exist yet and cannot be normalized.
 *
 * 2. **Race conditions**: The filesystem state can change between normalization
 *    and actual file access, creating TOCTOU (Time-Of-Check-Time-Of-Use) vulnerabilities.
 *
 * 3. **Complexity**: Proper normalization requires Windows-specific APIs, handling
 *    multiple edge cases, and dealing with various path formats (UNC, device paths, etc.).
 *
 * 4. **Reliability**: Pattern detection is more predictable and doesn't depend on
 *    external system state.
 *
 * If you are considering adding normalization for these paths, please reach out to
 * AppSec first to discuss the security implications and implementation approach.
 *
 * @param path The path to check for suspicious patterns
 * @returns true if suspicious Windows path patterns are detected
 */
function hasSuspiciousWindowsPathPattern(path: string): boolean {
  // Check for NTFS Alternate Data Streams
  // Look for ':' after position 2 to skip drive letters (e.g., C:\)
  // Examples: file.txt::$DATA, .bashrc:hidden, settings.json:stream
  // Note: ADS colon syntax is only interpreted by the Windows kernel. On WSL,
  // DrvFs mounts route file operations through the Windows kernel, so colon
  // syntax is still interpreted as ADS separators. On Linux/macOS (non-WSL),
  // even when NTFS is mounted, ADS is accessed via xattrs (ntfs-3g) not colon
  // syntax, and colons are valid filename characters.
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  // Check for 8.3 short names
  // Look for '~' followed by a digit
  // Examples: GIT~1, CLAUDE~1, SETTIN~1.JSON, BASHRC~1
  if (/~\d/.test(path)) {
    return true
  }

  // Check for long path prefixes (both backslash and forward slash variants)
  // Examples: \\?\C:\Users\..., \\.\C:\..., //?/C:/..., //./C:/...
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  // Check for trailing dots and spaces that Windows strips during path resolution
  // Examples: .git., .claude , .bashrc..., settings.json.
  // This can bypass string matching if ".git" is blocked but ".git." is used
  if (/[.\s]+$/.test(path)) {
    return true
  }

  // Check for DOS device names that Windows treats as special devices
  // Examples: .git.CON, settings.json.PRN, .bashrc.AUX
  // Device names: CON, PRN, AUX, NUL, COM1-9, LPT1-9
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  // Check for three or more consecutive dots (...) when used as a path component
  // This pattern can be used to bypass security checks or create confusion
  // Examples: .../file.txt, path/.../file
  // Only block when dots are preceded AND followed by path separators (/ or \)
  // This allows legitimate uses like Next.js catch-all routes [...]name]
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  // Check for UNC paths (on all platforms for defense-in-depth)
  // Examples: \\server\share, \\foo.com\file, //server/share, \\192.168.1.1\share
  // UNC paths can access remote resources, leak credentials, and bypass working directory restrictions
  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

/**
 * Checks if a path is safe for auto-editing (acceptEdits mode).
 * Returns information about why the path is unsafe, or null if all checks pass.
 *
 * This function performs comprehensive safety checks including:
 * - Suspicious Windows path patterns (NTFS streams, 8.3 names, long path prefixes, etc.)
 * - Claude config files (.claude/settings.json, .claude/commands/, .claude/agents/)
 * - MCP CLI state files (managed internally by Claude Code)
 * - Dangerous files (.bashrc, .gitconfig, .git/, .vscode/, .idea/, etc.)
 *
 * IMPORTANT: This function checks BOTH the original path AND resolved symlink paths
 * to prevent bypasses via symlinks pointing to protected files.
 *
 * @param path The path to check for safety
 * @returns Object with safe=false and message if unsafe, or { safe: true } if all checks pass
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
):
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean } {
  // Get all paths to check (original + symlink resolved paths)
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Check for suspicious Windows path patterns on all paths
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
      }
    }
  }

  // Check for Claude config files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isClaudeConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        classifierApprovable: true,
      }
    }
  }

  // Check for dangerous files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to edit ${path} which is a sensitive file.`,
        classifierApprovable: true,
      }
    }
  }

  // All safety checks passed
  return { safe: true }
}

export function allWorkingDirectories(
  context: ToolPermissionContext,
): Set<string> {
  return new Set([
    getOriginalCwd(),
    ...context.additionalWorkingDirectories.keys(),
  ])
}

// Resolved forms of a working directory, recomputed on each permission check.
//
// This was `memoize(getPathsForPermissionCheck)`, justified by the claim that
// "getPathsForPermissionCheck is deterministic for existing directories within
// a session". It is not: it is a symlink chain walk, so its answer is a
// property of the filesystem at the moment it runs, not of the string it was
// handed. Read-only does not imply idempotent, and that inference is what put
// a cache here — it is the same false step that was made at the config-dir
// roots, which is why the two were fixed together rather than separately.
//
// The stale value was worse here than there: the cache held the walk itself,
// keyed on an arbitrary path rather than on two known roots, so it had more
// entries — and a working directory is far likelier to be repointed
// mid-session than a config dir is.
//
// The name is kept rather than inlined because `pathValidation.ts` documents
// its own cost model as "matching getResolvedWorkingDirPaths", so the identity
// is referred to from outside this file even though the only call is below.
// The previous justification for the `export` — clearing the cache from
// `test/preload.ts` — went with the cache, and that file does not exist in
// this repo in any case.
export const getResolvedWorkingDirPaths = getPathsForPermissionCheck

export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  // Check both the original path and the resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Resolve working directories the same way we resolve input paths so
  // comparisons are symmetric. Without this, a resolved input path
  // (e.g. /System/Volumes/Data/home/... on macOS) would not match an
  // unresolved working directory (/home/...), causing false denials.
  const workingPaths = Array.from(
    allWorkingDirectories(toolPermissionContext),
  ).flatMap(wp => getResolvedWorkingDirPaths(wp))

  // All paths must be within allowed working paths
  // If any resolved path is outside, deny access
  return pathsToCheck.every(pathToCheck =>
    workingPaths.some(workingPath =>
      pathInWorkingPath(pathToCheck, workingPath),
    ),
  )
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  // On macOS, handle common symlink issues:
  // - /var -> /private/var
  // - /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  // Normalize case for case-insensitive comparison to prevent bypassing security
  // checks on case-insensitive filesystems (macOS/Windows) like .cLauDe/CoMmAnDs
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(
    normalizedWorkingPath,
  )

  // Use cross-platform relative path helper
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  // Same path
  if (relative === '') {
    return true
  }

  if (containsPathTraversal(relative)) {
    return false
  }

  // Path is inside (relative path that doesn't go up)
  return !posix.isAbsolute(relative)
}

function rootPathForSource(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(getOriginalCwd())
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return getSettingsRootPathForSource(source)
  }
}

function prependDirSep(path: string): string {
  return posix.join(DIR_SEP, path)
}

function normalizePatternToPath({
  patternRoot,
  pattern,
  rootPath,
}: {
  patternRoot: string
  pattern: string
  rootPath: string
}): string | null {
  // If the pattern root + pattern combination starts with our reference root
  const fullPattern = posix.join(patternRoot, pattern)
  if (patternRoot === rootPath) {
    // If the pattern root exactly matches our reference root no need to change
    return prependDirSep(pattern)
  } else if (fullPattern.startsWith(`${rootPath}${DIR_SEP}`)) {
    // Extract the relative part
    const relativePart = fullPattern.slice(rootPath.length)
    return prependDirSep(relativePart)
  } else {
    // Handle patterns that are inside the reference root but not starting with it
    const relativePath = posix.relative(rootPath, patternRoot)
    if (
      !relativePath ||
      relativePath.startsWith(`..${DIR_SEP}`) ||
      relativePath === '..'
    ) {
      // Pattern is outside the reference root, so it can be skipped
      return null
    } else {
      const relativePattern = posix.join(relativePath, pattern)
      return prependDirSep(relativePattern)
    }
  }
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  // null root means the pattern can match anywhere
  const result = new Set(patternsByRoot.get(null) ?? [])

  for (const [patternRoot, patterns] of patternsByRoot.entries()) {
    if (patternRoot === null) {
      // already added
      continue
    }

    // Check each pattern to see if the full path starts with our reference root
    for (const pattern of patterns) {
      const normalizedPattern = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      })
      if (normalizedPattern) {
        result.add(normalizedPattern)
      }
    }
  }
  return Array.from(result)
}

/**
 * Collects all deny rules for file read permissions and returns their ignore patterns
 * Each pattern must be resolved relative to its root (map key)
 * Null keys are used for patterns that don't have a root
 *
 * This is used to hide files that are blocked by Read deny rules.
 *
 * @param toolPermissionContext
 */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    'read',
    'deny',
  )
  const result = new Map<string | null, string[]>()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}

function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
): {
  relativePattern: string
  root: string | null
} {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // Patterns starting with // resolve relative to /
    const patternWithoutDoubleSlash = pattern.slice(1)

    // On Windows, check if this is a POSIX-style drive path like //c/Users/...
    // Note: UNC paths (//server/share) will not match this regex and will be treated
    // as root-relative patterns, which may need separate handling in the future
    if (
      getPlatform() === 'windows' &&
      patternWithoutDoubleSlash.match(/^\/[a-z]\//i)
    ) {
      // Convert POSIX path to Windows format
      // The pattern is like /c/Users/... so we convert it to C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // Keep the pattern in POSIX format since relativePath returns POSIX paths
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // Extract the drive root (C:\) and the rest of the pattern
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // Patterns starting with ~/ resolve relative to homedir
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // Patterns starting with / resolve relative to the directory where settings are stored (without .claude/)
    return {
      relativePattern: pattern,
      root: rootPathForSource(source),
    }
  }
  // No root specified, put it with all the other patterns
  // Normalize patterns that start with "./" to remove the prefix
  // This ensures that patterns like "./.env" match files like ".env"
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // Apply Edit tool rules to any tool editing files
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // Apply Read tool rules to any tool reading files
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(
    toolPermissionContext,
    toolName,
    behavior,
  )
  // Resolve rules relative to path based on source
  const patternsByRoot = new Map<string | null, Map<string, PermissionRule>>()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map<string, PermissionRule>()
      patternsByRoot.set(root, patternsForRoot)
    }
    // Store the rule keyed by the root
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  let fileAbsolutePath = expandPath(path)

  // On Windows, convert to POSIX format to match against permission patterns
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    toolType,
    behavior,
  )

  // Check each root for a matching pattern
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // Transform patterns for the ignore library
    const patterns = Array.from(patternMap.keys()).map(pattern => {
      let adjustedPattern = pattern

      // Remove /** suffix - ignore library treats 'path' as matching both
      // the path itself and everything inside it
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // Use cross-platform relative path helper for POSIX-style patterns
    const relativePathStr = relativePath(
      root ?? getCwd(),
      fileAbsolutePath ?? getCwd(),
    )

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // The path is outside the root, so ignore it
      continue
    }

    // Important: ig.test throws if you give it an empty string
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // Map the matched pattern back to the original rule
      const originalPattern = igResult.rule.pattern

      // Check if this was a /** pattern we simplified
      const withWildcard = originalPattern + '/**'
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // No matching rule found
  return null
}

/**
 * Permission result for read permission for the specified tool & tool input
 */
export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // Get paths to check (includes both original and resolved symlinks).
  // Computed once here and threaded through checkWritePermissionForTool →
  // checkPathSafetyForAutoEdit → pathInAllowedWorkingPath to avoid redundant
  // existsSync/lstatSync/realpathSync syscalls on the same path (previously
  // 6× = 30 syscalls per Read permission check).
  const pathsToCheck = getPathsForPermissionCheck(path)

  // 1. Defense-in-depth: Block UNC paths early (before other checks)
  // This catches paths starting with \\ or // that could access network resources
  // This may catch some UNC patterns not detected by containsVulnerableUncPath
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which appears to be a UNC path that could access network resources.`,
        decisionReason: {
          type: 'other',
          reason: 'UNC path detected (defense-in-depth check)',
        },
      }
    }
  }

  // 2. Check for suspicious Windows path patterns (defense in depth)
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        decisionReason: {
          type: 'other',
          reason:
            'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification',
        },
      }
    }
  }

  // 3. Check for READ-SPECIFIC deny rules first - check both the original path and resolved symlink path
  // SECURITY: This must come before any allow checks (including "edit access implies read access")
  // to prevent bypassing explicit read deny rules
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to read ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 4. Check for READ-SPECIFIC ask rules - check both the original path and resolved symlink path
  // SECURITY: This must come before implicit allow checks to ensure explicit ask rules are honored
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 5. Edit access implies read access (but only if no read-specific deny/ask rules exist)
  // We check this after read-specific rules so that explicit read restrictions take precedence
  const editResult = checkWritePermissionForTool(
    tool,
    input,
    toolPermissionContext,
    pathsToCheck,
  )
  if (editResult.behavior === 'allow') {
    return editResult
  }

  // 6. Allow reads in working directories
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: 'default',
      },
    }
  }

  // 7. Allow reads from internal harness paths (session-memory, plans, tool-results)
  const absolutePath = expandPath(path)
  const internalReadResult = checkReadableInternalPath(absolutePath, input)
  if (internalReadResult.behavior !== 'passthrough') {
    return internalReadResult
  }

  // 8. Check for allow rules
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'read',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 12. Default to asking for permission
  // At this point, isInWorkingDir is false (from step #6), so path is outside working directories
  return {
    behavior: 'ask',
    message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'read',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories',
    },
  }
}

/**
 * Permission result for write permission for the specified tool & tool input.
 *
 * @param precomputedPathsToCheck - Optional cached result of
 *   `getPathsForPermissionCheck(tool.getPath(input))`. Callers MUST derive this
 *   from the same `tool` and `input` in the same synchronous frame — `path` is
 *   re-derived internally for error messages and internal-path checks, so a
 *   stale value would silently check deny rules for the wrong path.
 */
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 1. Check for deny rules - check both the original path and resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to edit ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 1.5. Allow writes to internal editable paths (plan files, scratchpad)
  // This MUST come before isDangerousFilePathToAutoEdit check since .claude is a dangerous directory
  const absolutePathForEdit = expandPath(path)
  const internalEditResult = checkEditableInternalPath(
    absolutePathForEdit,
    input,
  )
  if (internalEditResult.behavior !== 'passthrough') {
    return internalEditResult
  }

  // 1.6. Check for config-folder allow rules BEFORE safety checks
  // This allows session-level permissions to bypass the safety blocks for the
  // config folder. We only allow this for session-level rules to prevent users
  // from accidentally permanently granting broad access to it.
  //
  // matchingRuleForInput returns the first match across all sources. If the user
  // also has a broader rule in userSettings for any of the spellings this step
  // covers — Edit(/.axa/**), Edit(/.claude/**) or Edit(~/.axa/**), e.g. from
  // sandbox write-allow conversion — that rule would be found first and its
  // source check below would fail. Scope the search to session-only rules so the
  // dialog's "allow Claude to edit its own settings for this session" option
  // actually works.
  const configFolderAllowRule = matchingRuleForInput(
    path,
    {
      ...toolPermissionContext,
      alwaysAllowRules: {
        session: toolPermissionContext.alwaysAllowRules.session ?? [],
      },
    },
    'edit',
    'allow',
  )
  if (configFolderAllowRule) {
    // Check if this rule is scoped under a config folder (project, legacy
    // project, or global). Accepts both the broad patterns ('/.axa/**',
    // '/.claude/**', '~/.axa/**') and narrowed ones like
    // '/.axa/skills/my-skill/**' so users can grant session access to a single
    // skill without also exposing settings.json or hooks/. The rule already
    // matched the path via matchingRuleForInput; this is an additional scope
    // check. Reject '..' to prevent a rule like '/.axa/../**' from leaking
    // this bypass outside the config folder.
    const ruleContent = configFolderAllowRule.ruleValue.ruleContent
    if (
      ruleContent &&
      CONFIG_FOLDER_PERMISSION_PATTERNS.some(pattern =>
        ruleContent.startsWith(pattern.slice(0, -2)),
      ) &&
      !ruleContent.includes('..') &&
      ruleContent.endsWith('/**')
    ) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: configFolderAllowRule,
        },
      }
    }
  }

  // 1.7. Check comprehensive safety validations (Windows patterns, Claude config, dangerous files)
  // This MUST come before checking allow rules to prevent users from accidentally granting
  // permission to edit protected files
  const safetyCheck = checkPathSafetyForAutoEdit(path, pathsToCheck)
  if (!safetyCheck.safe) {
    // SDK suggestion: if under .claude/skills/{name}/, emit the narrowed
    // session-scoped addRules that step 1.6 will honor on the next call.
    // Everything else (.claude/settings.json, .git/, .vscode/, .idea/) falls
    // back to generateSuggestions — its setMode suggestion doesn't bypass
    // this check, but preserving it avoids a surprising empty array.
    const skillScope = getClaudeSkillScope(path)
    const safetySuggestions: PermissionUpdate[] = skillScope
      ? [
          {
            type: 'addRules',
            rules: [
              {
                toolName: FILE_EDIT_TOOL_NAME,
                ruleContent: skillScope.pattern,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck)
    return {
      behavior: 'ask',
      message: safetyCheck.message,
      suggestions: safetySuggestions,
      decisionReason: {
        type: 'safetyCheck',
        reason: safetyCheck.message,
        classifierApprovable: safetyCheck.classifierApprovable,
      },
    }
  }

  // 2. Check for ask rules - check both the original path and resolved symlink path
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 3. If in acceptEdits or sandboxBashMode mode, allow all writes in original cwd
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  // 4. Check for allow rules
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'edit',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 5. Default to asking for permission
  return {
    behavior: 'ask',
    message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'write',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const isOutsideWorkingDir = !pathInAllowedWorkingPath(
    filePath,
    toolPermissionContext,
    precomputedPathsToCheck,
  )

  if (operationType === 'read' && isOutsideWorkingDir) {
    // For read operations outside working directories, add Read rules
    // IMPORTANT: Include both the symlink path and resolved path so subsequent checks pass
    const dirPath = getDirectoryForPath(filePath)
    const dirsToAdd = getPathsForPermissionCheck(dirPath)

    const suggestions = dirsToAdd
      .map(dir => createReadRuleSuggestion(dir, 'session'))
      .filter((s): s is PermissionUpdate => s !== undefined)

    return suggestions
  }

  // Only suggest setMode:acceptEdits when it would be an upgrade. In auto
  // mode the classifier already auto-approves edits; in bypassPermissions
  // everything is allowed; in acceptEdits it's a no-op. Suggesting it
  // anyway and having the SDK host apply it on "Always allow" silently
  // downgrades auto → acceptEdits, which then prompts for MCP/Bash.
  const shouldSuggestAcceptEdits =
    toolPermissionContext.mode === 'default' ||
    toolPermissionContext.mode === 'plan'

  if (operationType === 'write' || operationType === 'create') {
    const updates: PermissionUpdate[] = shouldSuggestAcceptEdits
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : []

    if (isOutsideWorkingDir) {
      // For write operations outside working directories, also add the directory
      // IMPORTANT: Include both the symlink path and resolved path so subsequent checks pass
      const dirPath = getDirectoryForPath(filePath)
      const dirsToAdd = getPathsForPermissionCheck(dirPath)

      updates.push({
        type: 'addDirectories',
        directories: dirsToAdd,
        destination: 'session',
      })
    }

    return updates
  }

  // For read operations inside working directories, just change mode
  return shouldSuggestAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
}

/**
 * How much of a config dir (`~/.axa` and `<project>/.axa`) the harness may
 * reach without prompting.
 *
 * - `open`      — read and write silently. AXA.md and the agent-authored note
 *                 directories: prose the model writes for itself, enumerated in
 *                 CONFIG_DIR_OPEN_DIRS / CONFIG_DIR_OPEN_FILES.
 * - `protected` — readable, but writes fall through to the safety gate and
 *                 prompt. Files that get *executed*, that grant permission, or
 *                 that record what happened. This is the default: a config-dir
 *                 path nobody classified lands here.
 * - `secret`    — neither read nor write without a prompt. Credentials, and the
 *                 cross-project transcript stores, where the risk is
 *                 disclosure rather than tampering.
 * - `outside`   — not under a config dir; no carve-out applies.
 */
type ConfigDirAccess = 'open' | 'protected' | 'secret' | 'outside'

/**
 * Credential material. Withheld from reads as well as writes, because reading
 * these is exfiltration, not just tampering.
 *
 * `backups/` is here because it holds `config.json.backup.<ts>` copies —
 * whole-file snapshots of the OAuth tokens, and the source findMostRecentBackup
 * restores from, so a crafted backup is also a way to inject config later.
 */
const CONFIG_DIR_SECRET_DIRS = new Set([
  'backups',
  // Not credentials, but disclosure rather than tampering is the risk, which
  // is what puts them on the read side of the line. `projects/` holds session
  // transcripts for *every* project on the machine, so a silent read lets an
  // agent working in one repo read another repo's history. Today a read of
  // ~/.axa/projects/<other>/x.jsonl reaches step 12 of
  // checkReadPermissionForTool and asks, because step 6 only covers working
  // directories; classifying these 'protected' would have quietly removed that
  // prompt. `sessions/` is the same data by another name.
  'projects',
  'sessions',
  // `ide/` holds the IDE lockfiles, and each one carries an `authToken`
  // (utils/ide.ts, parsed at readLockfile and presented at connectToIde to
  // authenticate the websocket). Reading one discloses that token, which is why
  // it is here and not merely `protected` — `protected` is readable. Writing one
  // points the IDE channel at a chosen port with a token axa will then present.
  'ide',
])
const CONFIG_DIR_SECRET_FILES = new Set(['.credentials.json'])
/**
 * The global config file is matched through `isGlobalConfigFileName`
 * (constants/oauth.ts) rather than by a literal here. Its name is *computed* —
 * `config${fileSuffixForOauthConfig()}.json` — and has four spellings, of which
 * `config-custom-oauth.json` is live in a shipped binary: the other two suffixes
 * are behind `USER_TYPE === 'ant'`, which scripts/build.ts `--define`s away, but
 * `CLAUDE_CODE_CUSTOM_OAUTH_URL` is tested before that switch and is not gated
 * on it. Holding the literal `config.json` here covered one spelling of four.
 * The predicate lives beside the function that computes the name so the two
 * cannot drift.
 */

/**
 * `grok-api-key` and any future `<provider>-api-key`. Matched by shape rather
 * than by name so adding a provider does not silently open a hole — the user
 * cannot reissue the Grok key, so a truncating write is unrecoverable.
 */
const CONFIG_DIR_API_KEY_FILE_PATTERN = /api[-_]?key$/

/**
 * Directories under a config dir whose contents are executed, or whose
 * integrity the session depends on:
 *
 * - `hooks/`           — arbitrary code, run on the next tool call.
 * - `plugins/`         — plugin code, plus the hooks and MCP servers a plugin
 *                        declares.
 * - `shell-snapshots/` — `source`d into every Bash invocation
 *                        (shell/bashProvider.ts).
 * - `session-env/`     — hook env scripts, concatenated into every Bash
 *                        invocation (sessionEnvironment.ts).
 * - `local/`           — the installed binary and its node_modules.
 * - `chrome/`          — `chrome-native-host`, a `#!/bin/sh` wrapper written and
 *                        chmod 0755'd by createWrapperScript
 *                        (claudeInChrome/setup.ts). It exists because Chrome's
 *                        native-host manifest `path` cannot carry arguments, so
 *                        the manifest points at this script and Chrome executes
 *                        it. Same property as `hooks/`, executed by a different
 *                        process. (`chrome-native-host.bat` on Windows.)
 *
 * And four that are worse than merely executed, because the same file that
 * carries the code also states the permission it runs under — or, in the last
 * case, states the instructions everything else runs under:
 *
 * - `skills/`, `commands/` — a SKILL.md body is run through
 *   `executeShellCommandsInPrompt` (skills/loadSkillsDir.ts), which matches
 *   ```! … ``` and !`…` and calls `BashTool.call()` directly, bypassing
 *   validateInput. The permission context it is handed has `alwaysAllowRules.
 *   command` set to that same file's `allowed-tools` frontmatter, so the file
 *   authorizes its own shell. `commands/` is the same loader
 *   (`loadSkillsFromCommandsDir`), so it inherits the property exactly. The
 *   `loadedFrom !== 'mcp'` guard beside the call is the authors saying skill
 *   markdown from an untrusted source must not execute inline shell; a silent
 *   write here would make the filesystem such a source while leaving it on the
 *   trusted side of that guard.
 * - `agents/`            — an agent definition's *body* is prompt text and does
 *   not execute, but its frontmatter is permission-granting twice over:
 *   `permissionMode` accepts `bypassPermissions` (PERMISSION_MODES in
 *   types/permissions.ts), and `mcpServers` accepts an inline stdio config
 *   whose `command` is spawned by `connectAgentMcpServers` (AgentTool/
 *   runAgent.ts). Writing an agent file is therefore writing a process launcher.
 * - `output-styles/`     — the weakest of the four, and listed for that reason.
 *   An output style grants no tools; what it does is *replace the system
 *   prompt* (getOutputStyleDirStyles, outputStyles/loadOutputStylesDir.ts).
 *   Writing one rewrites the instructions the model is operating under, which
 *   is the same tampering risk reached by a different route than execution.
 *   The argument to expect is "it is only markdown, like `rules/`" — true of
 *   the file, false of what consumes it.
 *
 * The first three were already always-ask at project scope via
 * `isClaudeConfigFilePath`. Listing them here keeps that decision intact at
 * user scope instead of silently reversing it — this carve-out runs at step
 * 1.5, ahead of the safety check that consults that function at step 1.7.
 * `output-styles` is absent from that function, so at project scope it has
 * only the ordinary safety check behind it. That gap predates this change and
 * is not created by it; it belongs with whoever owns that enumeration.
 *
 * The population those four are drawn from is `CLAUDE_CONFIG_DIRECTORIES`
 * (utils/markdownConfigLoader.ts), every member of which `loadMarkdownFilesFor`
 * `Subdir` reads from `join(getClaudeConfigHomeDir(), subdir)`. The other two,
 * `workflows` and `templates`, have no loader calling them today — only
 * `commands`, `agents` and `output-styles` do, plus a variable `subdir` in
 * hooks/fileSuggestions.ts. They are left to the default; list them here if a
 * loader appears.
 *
 * Every name here is redundant with the default, which is `protected`. The set
 * is kept and still consulted because these are the names most likely to be
 * proposed for the allow-list below, and the reason each one must stay off it
 * is only useful if it travels with the name.
 */
const CONFIG_DIR_PROTECTED_DIRS = new Set([
  'hooks',
  'plugins',
  'shell-snapshots',
  'session-env',
  'local',
  'chrome',
  'skills',
  'commands',
  'agents',
  'output-styles',
])

/**
 * The allow-list: everything under a config dir that is silently writable.
 * Anything not named here is `protected`, i.e. readable but prompted on write.
 *
 * This is an allow-list rather than a deny-list because the config dir is a
 * shared namespace that other subsystems keep adding to, and a deny-list makes
 * every new arrival permissive by default. That is not hypothetical: `skills`,
 * `commands`, `agents`, `cowork_settings.json`, `remote-settings.json` and
 * `cowork_plugins` were all reachable under the deny-list version, each found
 * by a different reviewer, none by the list itself. A list cannot tell you what
 * it is missing.
 *
 * The failure mode is now inverted with it: forgetting an entry costs a
 * permission prompt the user did not need, instead of a silent write to the
 * top-precedence settings layer.
 *
 * Contents are prompt/markdown text and notes, never code and never permission
 * rules:
 * - `agent-memory/`, `plans/` — agent-authored notes and plans.
 * - `magic-docs/`             — `prompt.md`, a user-supplied prompt override
 *                               (services/MagicDocs/prompts.ts).
 * - `rules/`                  — the same content class as the memory file:
 *                               `processMdRules` (utils/claudemd.ts) reads
 *                               `<config>/rules/**.md` at user and project scope
 *                               and concatenates them into project memory. The
 *                               only frontmatter it honours is `globs`, a
 *                               matcher — unlike `agents/` and `skills/`, a rule
 *                               file grants nothing. Opening the memory file but
 *                               not `rules/` would split one feature in half.
 *
 * Note these mostly have their *own* earlier carve-outs in
 * checkEditableInternalPath and are listed again here so that the classifier is
 * independently correct rather than relying on being unreachable.
 */
const CONFIG_DIR_OPEN_DIRS = new Set([
  'agent-memory',
  // The 'local' scope of the same feature: getAgentMemoryDir writes
  // <cwd>/.axa/agent-memory-local/<agentType>/ (AgentTool/agentMemory.ts).
  // isAgentMemoryPath already allows it earlier, so this changes no behaviour —
  // it is here because the point of listing the earlier carve-outs again is that
  // this classifier be independently correct rather than correct-by-unreachable,
  // and a second spelling of a listed feature is exactly what that misses.
  'agent-memory-local',
  'plans',
  'magic-docs',
  'rules',
])

/** The memory file itself, at the config dir root. */
const CONFIG_DIR_OPEN_FILES = new Set([
  normalizeCaseForComparison(MEMORY_FILE_NAME),
])

/**
 * Mode-dependent name prefixes, stripped before the set lookup above.
 *
 * `--cowork` / CLAUDE_CODE_USE_COWORK_PLUGINS swap whole config-dir entries for
 * a twin: `getPluginsDirectoryName()` (plugins/pluginDirectories.ts) returns
 * `cowork_plugins` instead of `plugins`, under the same config home. Listing
 * only `plugins` protected the default mode and left the flagged mode writable.
 * Matching by shape means the next such twin is covered when it is added, not
 * when someone remembers to list it.
 */
const CONFIG_DIR_MODE_PREFIX_PATTERN = /^cowork_/

/**
 * Settings files anywhere under a config dir.
 *
 * Deliberately matched by shape, because the set of names the code can produce
 * is larger than the set anyone lists from memory. All four of these are real
 * and all four carry `permissions.deny`, i.e. the rules this engine enforces:
 *
 * - `settings.json`        — user and project scope.
 * - `settings.local.json`  — `getRelativeSettingsFilePathForSource`.
 * - `cowork_settings.json` — `getUserSettingsFilePath` (settings/settings.ts)
 *                            returns this *instead of* settings.json in cowork
 *                            mode, so in that mode it simply is userSettings.
 * - `remote-settings.json` — the managed-policy sync cache, written into the
 *                            config home by remoteManagedSettings/syncCacheState.
 *
 * A write to any of them is a write to the rules that decide whether the write
 * was allowed, which is why they never become silently writable.
 *
 * The optional leading segment makes this over-inclusive: an unrelated
 * `foo-settings.json` would also match. That is the intended direction of
 * error. A false positive costs one permission prompt; a false negative is a
 * silent write to a deny list.
 */
const CONFIG_DIR_SETTINGS_FILE_PATTERN =
  /^([a-z0-9]+[_-])?settings(\.[^.]+)?\.json$/
/**
 * `history.jsonl` and its rotations — classified `secret`, i.e. withheld from
 * reads, not merely from writes.
 *
 * makeLogEntryReader (src/history.ts) calls it "global history file (shared
 * across all projects)", and each entry carries `display`, the raw prompt text,
 * plus `pastedContents`. That is the same cross-project disclosure that puts
 * `projects/` and `sessions/` on the secret list, in a single file. Classifying
 * it on tampering risk alone would have left every prompt the user has typed in
 * any repo silently readable from this one.
 */
const CONFIG_DIR_HISTORY_FILE_PATTERN = /^history\.jsonl(\..*)?$/

/**
 * Resolved forms of the two config dir roots.
 *
 * Computed once per classification and deliberately **not** memoized for the
 * session. The previous shape cached this on `${home}\u0000${project}`, and
 * that key is genuinely session-stable — which is precisely what made it look
 * safe. The key was never the problem. The *value* is: what a path resolves to
 * is filesystem state, not a function of the string, so a root that is
 * relinked mid-session leaves a cache that is wrong in **both** directions at
 * once. It keeps matching the old target and stops matching the new one.
 * Validating the input cannot repair a value that was correct when it was
 * stored, which is why this is a cache-removal and not a guard.
 *
 * Do not write one severity sentence for the two consumers — they fail in
 * opposite directions from the same stale value. In `classifyConfigDirPath` a
 * root that no longer matches yields `null`, which reads as "not a config-dir
 * path at all" and skips the classification entirely: **fails open**. In
 * `isReadableConfigDirPath` the same `null` returns false: **fails closed**.
 *
 * The argument is stripped with `stripTrailingSeparatorsForWalk` rather than
 * passed through, because it is handed to a live chain walk.
 * `getClaudeConfigHomeDir()` returns `CLAUDE_CONFIG_DIR` verbatim, so a user's
 * trailing separator — or a bare drive root — arrives here exactly as typed.
 * Same defect and same fix as the fold site; see that function for why the
 * strip has to know the difference between a spelling and a denotation.
 */
function getResolvedConfigDirRoots(
  homeConfigDir: string,
  projectConfigDir: string,
): string[][] {
  return [homeConfigDir, projectConfigDir].map(root =>
    getPathsForPermissionCheck(stripTrailingSeparatorsForWalk(root)).map(
      normalize,
    ),
  )
}

/**
 * The path of `normalizedPath` relative to the **innermost** config dir root
 * that contains it, or null if none does. `''` means the root itself.
 *
 * `roots` is passed in rather than fetched here so that a caller looping over
 * the resolved forms of one path resolves the roots once, not once per form.
 *
 * ## Why longest-root-wins, and not the first root in the list
 *
 * The two roots can nest: the project config dir is `<cwd>/.axa`, and nothing
 * stops `cwd` from being inside the config home — `~/.axa/plans` and
 * `~/.axa/rules` are directories this app creates itself, so `cd ~/.axa/plans`
 * and starting a session is ordinary use, not an exotic setup.
 *
 * When they nest, a path under the inner root matches both. This function used
 * to return on the **first** match, and the roots are iterated `[home,
 * project]`, so in that configuration it returned the *outer* root's relative
 * path — `plans/.axa/hooks/h.sh` instead of `hooks/h.sh`.
 *
 * That is not a cosmetic difference, because `classifyConfigDirRelativePath`
 * reads two things out of the relative path and only one of them survives the
 * substitution:
 *
 * - the **first segment**, against CONFIG_DIR_SECRET_DIRS,
 *   CONFIG_DIR_PROTECTED_DIRS and CONFIG_DIR_OPEN_DIRS. The outer root replaces
 *   it with the *project directory's own name*, so every one of these
 *   classifications is decided by the wrong string.
 * - the **basename**, against the settings-file shape, the credential and
 *   history patterns and the global config names. This is root-independent by
 *   construction and was never affected.
 *
 * So the defect is precisely: **first-segment classifications were bypassed,
 * basename ones were not.** Both halves are measured below, and the basename
 * rows are what make the account falsifiable rather than a story — if a fix
 * moved those too, this explanation would be wrong.
 *
 * It failed in **both** directions, which is why "the outer root is merely less
 * specific, so this over-blocks" is not a safe reading of it:
 *
 * - **Over-block.** With `cwd` = `<cfg>/proj`, `<cwd>/.axa/rules/note.md` and
 *   `<cwd>/.axa/AXA.md` came back `passthrough` for both read and write, where
 *   the identical project sitting outside the config home gets `allow`. The
 *   first segment was `proj`, on none of the lists, so the default applied.
 * - **Fail open.** The five names in CONFIG_DIR_OPEN_DIRS are themselves
 *   directories inside the config home, so `cwd` can *be* one of them. With
 *   `cwd` = `<cfg>/rules`, the first segment became `rules` — an open dir — and
 *   the whole of `<cwd>/.axa` was classified `open`, i.e. silently writable and
 *   silently readable. Measured: `<cwd>/.axa/hooks/h.sh` returned `allow` for
 *   **write**. A hook is a shell command executed on the next launch, so that
 *   is a silent write to code that runs. `<cwd>/.axa/projects/s.jsonl`, which
 *   the inner root classifies `secret`, returned `allow` for **read**.
 *   Meanwhile `<cwd>/.axa/settings.json` and `<cwd>/.axa/.credentials.json`
 *   stayed `passthrough` throughout — the basename half holding, as above.
 *
 * The fix moves each of those to exactly what the same file gets under a
 * non-nested project config dir: hooks and agents to `passthrough`/`allow`,
 * `projects/` to `passthrough`/`passthrough`.
 *
 * ## What the ordering actually was
 *
 * Call it list-order-wins, not shortest-wins. The two coincide only because the
 * home config dir is listed first *and* is the outer one in the reachable
 * nesting. In the opposite nesting — CLAUDE_CONFIG_DIR pointed at a directory
 * inside `<cwd>/.axa` — list order already picks the inner root, and every row
 * is byte-identical before and after this change. That arm is the control that
 * makes this a targeted fix rather than a behaviour change: it moves the
 * configuration where list order picks the outer root, and nothing else.
 *
 * ## Kept in step with foldResolvedRootPrefix
 *
 * That function has always resolved this the same way, via `foldedRootLength`,
 * and the two are otherwise the same walk over the same shape. `<=` sends ties
 * to the earlier root for the same reason it does there: a tie means two roots
 * resolve to the same directory, so the relative paths are identical anyway.
 *
 * They also now carry the same root-only branch, and that one is not cosmetic:
 * the two reach it over different root sets, and the fold needs an extra guard
 * on the side it emits. Both are written up at `endsWithSeparatorSpelling`.
 *
 * One remaining difference between them is cosmetic and is left alone rather
 * than "aligned": the separator comparison here lowercases `s` and the fold
 * does not. This is settled by enumeration, not by sampling —
 * ROOT_SEPARATOR_SPELLINGS is `new Set([sep, '/'])`, so it has at most two
 * members, `'/'` and (on win32) `'\'`, and `toLowerCase` is the identity on
 * both. The call is a no-op on every input the set can hold. Removing it is
 * safe and pointless; adding it to the fold is equally so.
 */
function relativeToConfigDirRoot(
  normalizedPath: string,
  roots: string[][],
): string | null {
  const pathLower = normalizeCaseForComparison(normalizedPath)
  let relative: string | null = null
  let matchedRootLength = -1
  for (const rootForms of roots) {
    for (const rootForm of rootForms) {
      if (rootForm.length <= matchedRootLength) continue
      const rootLower = normalizeCaseForComparison(rootForm)
      if (pathLower === rootLower) {
        relative = ''
        matchedRootLength = rootForm.length
        continue
      }
      // A root form that already ends in a separator is a root-only spelling —
      // `/`, `C:\`, `\\server\share\`, `\\?\C:\` — preserved that way on
      // purpose; see `endsWithSeparatorSpelling`. Appending a second separator
      // to it matches nothing, so match on the bare root and take the remainder
      // from `rootForm.length`.
      //
      // Measured over the four root-only shapes plus `/cfg/` and `C:\cfg\`
      // controls: 5 of 7 rows move, all of them root-only, e.g. `C:\` with
      // `C:\a\b.md` goes null -> `a\b.md`, and both controls stay `a/b.md`.
      // Without the controls "root-only" could be a predicate that is always
      // true and the separator loop below would be dead.
      //
      // The direction is a **fail closed**, not a fail open: a null relative
      // reads as `'outside'` in `classifyConfigDirPath` and false in
      // `isReadableConfigDirPath`, and both consumers use those only to withhold
      // an allow, so today the carve-out silently stops applying and the path
      // falls through to ordinary permission rules.
      if (endsWithSeparatorSpelling(rootForm)) {
        if (pathLower.startsWith(rootLower)) {
          relative = normalizedPath.slice(rootForm.length)
          matchedRootLength = rootForm.length
        }
        continue
      }
      for (const s of ROOT_SEPARATOR_SPELLINGS) {
        if (pathLower.startsWith(rootLower + s.toLowerCase())) {
          relative = normalizedPath.slice(rootForm.length + s.length)
          matchedRootLength = rootForm.length
          break
        }
      }
    }
  }
  return relative
}

function classifyConfigDirRelativePath(
  relative: string,
): 'open' | 'protected' | 'secret' {
  const segments = relative.split(/[\\/]/).filter(s => s.length > 0)
  // The config dir itself: creating/truncating it is not an edit we want to
  // wave through.
  if (segments.length === 0) return 'protected'

  // Strip the mode prefix so `cowork_plugins` is judged as `plugins`.
  const first = normalizeCaseForComparison(segments[0]!).replace(
    CONFIG_DIR_MODE_PREFIX_PATTERN,
    '',
  )
  const base = normalizeCaseForComparison(segments[segments.length - 1]!)

  if (
    CONFIG_DIR_SECRET_DIRS.has(first) ||
    CONFIG_DIR_SECRET_FILES.has(base) ||
    isGlobalConfigFileName(base) ||
    CONFIG_DIR_HISTORY_FILE_PATTERN.test(base) ||
    CONFIG_DIR_API_KEY_FILE_PATTERN.test(base)
  ) {
    return 'secret'
  }

  if (
    CONFIG_DIR_PROTECTED_DIRS.has(first) ||
    CONFIG_DIR_SETTINGS_FILE_PATTERN.test(base)
  ) {
    return 'protected'
  }

  // The memory file, at the config dir root only.
  if (segments.length === 1 && CONFIG_DIR_OPEN_FILES.has(base)) return 'open'
  if (CONFIG_DIR_OPEN_DIRS.has(first)) return 'open'

  // The default is PROTECTED: anything under a config dir that is not on the
  // allow-list above is readable but prompts on write. If you are adding a
  // config-dir feature and your writes now prompt, that is this line, and the
  // fix is to add the directory to CONFIG_DIR_OPEN_DIRS — after checking it
  // against `isClaudeConfigFilePath`, which is consulted at step 1.7 of
  // checkWritePermissionForTool while this runs at step 1.5, so an `open` here
  // silently overrides an always-ask there.
  return 'protected'
}

/**
 * Classify `absolutePath` against the config dirs.
 *
 * Every resolved form of the path — lexical and symlink-chain — must land
 * inside a config dir, and the most restrictive classification across those
 * forms wins. Without that, a symlink placed inside `~/.axa/agents/` pointing
 * at `~/.ssh/authorized_keys` would inherit this carve-out. Same guard as the
 * template job directory above.
 */
function classifyConfigDirPath(absolutePath: string): ConfigDirAccess {
  const roots = getResolvedConfigDirRoots(
    getClaudeConfigHomeDir(),
    join(getOriginalCwd(), CONFIG_DIR_NAME),
  )
  let access: 'open' | 'protected' | 'secret' = 'open'
  for (const form of getPathsForPermissionCheck(absolutePath)) {
    const relative = relativeToConfigDirRoot(normalize(form), roots)
    if (relative === null) return 'outside'
    const formAccess = classifyConfigDirRelativePath(relative)
    if (formAccess === 'secret') return 'secret'
    if (formAccess === 'protected') access = 'protected'
  }
  return access
}

/**
 * Config-dir paths that are silently *readable* despite prompting on write.
 *
 * The read side needs its own allow-list rather than "everything that is not
 * `secret`". Deriving reads from the write classes made the read path a
 * deny-list — the shape this change removed from the write path — so an
 * unlisted directory was silently readable, and the enumeration had to be
 * complete for that to be safe. It was not: `debug/`, `telemetry/`, `traces/`,
 * `uploads/` and `usage-data/` are all real, none was classified, and nobody had
 * looked at what they hold.
 *
 * Rather than inspect those five and inherit the sixth, reads now fall closed
 * too. Note this is cheap to get wrong in the safe direction: on main, *every*
 * one of these paths already reached step 12 of checkReadPermissionForTool and
 * asked, so a narrow list here is not a regression against main — it just
 * declines to widen. Anything omitted keeps main's behaviour exactly.
 *
 * What is listed is the config-authoring surface, which is the use case this
 * carve-out exists for — you cannot help someone edit an agent definition or a
 * settings file that you are not allowed to read:
 *
 * - `skills/`, `commands/`, `agents/`, `output-styles/`, `hooks/`, `plugins/` —
 *   definitions the model routinely reads to explain or edit. Writes still
 *   prompt; these are permission-granting, executed, or prompt-replacing, which
 *   is a tampering risk, not a disclosure one.
 *
 * Settings files are deliberately NOT here, even though the write-side
 * classifier treats them as config-authoring surface. A settings file can carry
 * credentials directly — `apiKeyHelper`, `awsAuthRefresh` and the `env` block
 * all live in the settings schema — so making it silently readable is a
 * disclosure widening, not a convenience. Reading one still prompts, exactly as
 * on main. Only the credential *files* are `secret`; the settings file is not,
 * so nothing else stops it.
 */
const CONFIG_DIR_READABLE_DIRS = new Set([
  'skills',
  'commands',
  'agents',
  'output-styles',
  'hooks',
  'plugins',
])

/**
 * Does any resolved form of `absolutePath` land on an active config file that a
 * command-line flag pointed somewhere arbitrary?
 *
 * Two flags do this, and they are one hazard, not two:
 *
 * - `--settings <path>` — settings hold credentials (`apiKeyHelper`,
 *   `awsAuthRefresh`, `env`), and the deny rules protecting the OAuth tokens
 *   live there too, so a silent write is circular: an agent could delete the
 *   rules first.
 * - `--mcp-config <path>` — MCP server entries carry `env` blocks and a spawned
 *   `command`, so a silent write there is code execution on the next launch.
 *   Its inline-JSON form is parsed straight from the argument and has no path,
 *   so there is nothing to protect. Do not generalise that to `--settings`:
 *   CLI-inline `--settings '{...}'` *does* get a path, because loadSettingsFromFlag
 *   writes it to a temp file. It is safe for a different reason — the temp dir
 *   is outside every config dir, so the carve-out never classifies it 'open'.
 *
 * Either can be aimed inside a config directory that this file otherwise treats
 * as freely readable or writable, and those branches run before step 1.7's
 * always-ask, so without this they override it.
 *
 * Checking every resolved form, not just the literal path, is the point: a
 * symlink at `~/.axa/agent-memory/alias.json` pointing at such a file elsewhere
 * under the config dir passes the classifier — every form is still `open` — and
 * a check on the literal path alone would not see what it resolves to.
 *
 * Both sides are expanded, not just the candidate. `--settings` stores a
 * realpath-canonical path but `--mcp-config` stores a lexically resolved one, so
 * comparing expanded-candidate against stored-string catches a symlink aimed at
 * the flag path while missing the case where the flag path is *itself* a symlink
 * and the tool targets its target. Laundering has two directions and covering
 * one of them is the recurring defect in this area; comparing form-set against
 * form-set is what makes the direction stop mattering.
 *
 * DO NOT memoize `configForms`. It looks like a session-stable set derived from
 * flag state, and it is not: `getPathsForPermissionCheck` is a *live filesystem
 * resolution*, so the answer changes when the filesystem changes under a fixed
 * path. Replace an active `--settings <p>` with a symlink to elsewhere and a
 * cached expansion of `<p>` no longer contains the target, so a write addressed
 * to the target stops matching — reopening the exact laundering direction the
 * paragraph above closes, through the cache instead of through the comparison.
 *
 * That sequence is reachable by an agent that can already run Bash commands —
 * it needs a session where Bash is auto-approved or broadly allowed, so it is a
 * privilege-amplification step rather than an unprivileged one. Given that, the
 * reflex answer is "surely Bash blocks the `ln` itself", and it does not: `ln`
 * is absent from `PathCommand` / `PATH_EXTRACTORS` in
 * tools/BashTool/pathValidation.ts, so `ln -sf` is `passthrough` there as a
 * non-path-restricted command and is never mapped to a write on the link
 * location. `mv` and `cp` are in that table; `ln` is the gap. (bashSecurity.ts
 * blocks the zsh builtin `zf_ln` as a binary-check bypass, which reads as
 * though the binary were checked. It is not.)
 *
 * The cost is real and was measured: ~52us of the ~104us per permission check,
 * on a path this now runs for *every* file check. It is spread across the four
 * `getSettingsPaths()` entries rather than concentrated in one — per-entry
 * timings land within about 1.5x of each other. The priciest single entry is
 * the one that does not exist on most machines
 * (`/Library/.../managed-settings.json`), which takes the `!existsSync` branch
 * of `getPathsForPermissionCheck` and so resolves ancestor directory symlinks
 * through `resolveDeepestExistingAncestorSync`; but that premium over an
 * existing entry is only ~5us, so shipping the file to avoid the branch would
 * buy about 5% of a check. That spread is also why the obvious cheap
 * revalidation fails: correctness depends on every entry the walk consulted,
 * ancestors included, so a sound revalidation costs about what the walk costs.
 * A basename prefilter is unsound for the same reason the old comparison was —
 * resolution changes the basename. And "only run this where a carve-out would
 * return allow" is the guard-beside-one-consumer bug that produced five
 * findings on this file; it is not an optimization, it is the defect.
 */
function resolvesToFlagConfigFile(absolutePath: string): boolean {
  const normalizeForm = (path: string): string =>
    normalizeCaseForComparison(normalize(path))
  const configForms = new Set(
    [...getSettingsPaths(), ...getFlagMcpConfigPaths()].flatMap(path =>
      getPathsForPermissionCheck(path).map(normalizeForm),
    ),
  )
  return getPathsForPermissionCheck(absolutePath).some(
    // isClaudeSettingsPath is kept alongside the expanded set because it also
    // matches `<anything>/.claude/settings.json` by suffix, for other projects,
    // which is a pattern rather than a path and so cannot be expanded.
    form => isClaudeSettingsPath(form) || configForms.has(normalizeForm(form)),
  )
}

/**
 * Is every resolved form of `absolutePath` on the read allow-list above?
 *
 * All forms must qualify, so the strictest wins, for the same reason
 * classifyConfigDirPath checks every form: otherwise a symlink under
 * `~/.axa/agents/` would launder a read of something else.
 *
 * Flag-supplied config files are screened by the caller, which covers the
 * 'open' arm this function is never reached on.
 */
function isReadableConfigDirPath(absolutePath: string): boolean {
  const roots = getResolvedConfigDirRoots(
    getClaudeConfigHomeDir(),
    join(getOriginalCwd(), CONFIG_DIR_NAME),
  )
  for (const form of getPathsForPermissionCheck(absolutePath)) {
    const relative = relativeToConfigDirRoot(normalize(form), roots)
    if (relative === null) return false
    const segments = relative.split(/[\\/]/).filter(s => s.length > 0)
    if (segments.length === 0) return false
    const first = normalizeCaseForComparison(segments[0]!).replace(
      CONFIG_DIR_MODE_PREFIX_PATTERN,
      '',
    )
    if (!CONFIG_DIR_READABLE_DIRS.has(first)) {
      return false
    }
  }
  return true
}

/**
 * The roots a resolved form may be folded back onto, each paired with the
 * lexical spelling the carve-outs actually compare against.
 *
 * The two sides of a carve-out are spelled differently and always have been.
 * `getClaudeConfigHomeDir` returns `CLAUDE_CONFIG_DIR` (or `~/CONFIG_DIR_NAME`)
 * NFC-normalised and otherwise verbatim — no realpath — so every carve-out
 * rooted there compares against the *lexical* spelling. `relativeToConfigDirRoot`,
 * by contrast, expands its roots through `getResolvedConfigDirRoots`, which is
 * why only some carve-outs care.
 *
 * An earlier draft of this paragraph offered `getClaudeTempDir` as the
 * resolved-side counter-example. It is not one, and its own docblock ("with
 * symlinks resolved") is wrong in the same way: it realpaths the *base* —
 * `CLAUDE_CODE_TMPDIR` or `/tmp` — and then joins `claude-{uid}` without
 * resolving it. Put a link at that tail component and the root is as lexical as
 * the config home from there down, which is why it is in the set below. The
 * general shape: "this one resolves" is a claim about which *component* it
 * resolves, and a root that resolves its parent is still lexical at its leaf.
 *
 * The set is exactly the roots that are (a) spelled lexically by a carve-out and
 * (b) able to be pointed somewhere non-canonical by the user's own
 * configuration. It is deliberately not "the working tree": folding on bare
 * `cwd` would rewrite the prefix of every resolved form under the whole project
 * for the sake of two subtrees that can be named directly.
 *
 *  - the user config dir, which most lexically-spelled roots descend from —
 *    `getProjectsDir`/`getProjectDir`, `getTeamsDir`, the tasks dir and
 *    `getPlansDirectory`'s default are all plain `join`s off it, which is why
 *    one fold root covers so many carve-outs;
 *  - `getMemoryBaseDir()`, which is *not* one of those joins: with
 *    `CLAUDE_CODE_REMOTE_MEMORY_DIR` set it returns that env value verbatim, and
 *    `isAgentMemoryPath` user scope roots at it. Without this entry a remote
 *    memory dir reached through a link loses both its agent-memory carve-outs;
 *  - the project config dir at **both** `getOriginalCwd()` and `getCwd()`. They
 *    are usually equal and dedupe away, but they are different carve-outs'
 *    roots: `launch.json` matches against `getOriginalCwd()` while
 *    `isAgentMemoryPath` project scope matches against `getCwd()`. Once the
 *    session changes directory they diverge, and folding on only one of them
 *    denies the other's carve-out;
 *  - `getPlansDirectory()`, because `settings.plansDirectory` is resolved
 *    against cwd and constrained only to stay inside the project root, so
 *    `docs/plans` is legal and lands outside both config dirs;
 *  - `getAutoMemPath()`, because `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` and
 *    `settings.autoMemoryDirectory` can put it anywhere on disk — including
 *    outside the project, which bare `cwd` never covered either. Note the two
 *    arms differ and only one of them is gated: the write carve-out is
 *    `!hasAutoMemPathOverride() && isAutoMemPath(…)`, so an *overridden*
 *    directory is out of scope for writes and falls through to the normal
 *    permission flow, while the read carve-out calls `isAutoMemPath` ungated
 *    and so covers the override directory too. The root is needed for the read
 *    side regardless of the override;
 *  - `getClaudeTempDir()`, for the reason given above — lexical at its `claude-{uid}`
 *    component. Four carve-outs root there: the project temp dir, the scratchpad
 *    pair and the bundled-skills root. Only the first is measured; the scratchpad
 *    is behind `isScratchpadEnabled()` and bundled skills carries a per-process
 *    nonce, so the other three are covered by construction rather than by a row.
 *    It returns a trailing separator — but so can other roots in this list, and
 *    an earlier version of this comment claimed the strip was needed for this
 *    entry alone. That was false: see `stripTrailingSeparators`, which is now
 *    applied uniformly to every root on both sides.
 *
 * **NOT memoized, and that is load-bearing rather than an oversight.** It was
 * memoized on the root list, and the cache was a hole: keying on the *lexical*
 * roots while caching their *resolved* forms means repointing a root symlink
 * mid-session leaves a dead directory installed as a config root. A link at a
 * legitimate name under the live root, pointing into the dead one, then resolves
 * to a form the stale entry still folds back onto the live lexical root, where
 * it is re-decided as a config file and agrees — an `allow` minted out of the
 * cache. The same stale entry denies the *live* root's own files, because their
 * forms no longer match any cached root. audit-2-2 built the proof
 * (`/private/tmp/axfold/stale2.mjs`); both halves reproduced, and dropping the
 * cache closes both.
 *
 * Note what that does to the precedent: `resolvesToFlagConfigFile` above carries
 * the same prohibition in capitals, and commit 5ef0c26 exists solely to record
 * it. The argument for an exception here was that nothing is caller-supplied —
 * the roots come from env, settings and session state. That argument is true and
 * insufficient. What the roots *resolve to* is not session state at all; it is
 * filesystem state, and the filesystem is exactly the thing an attacker can
 * change under a running process. `getResolvedConfigDirRoots` cached the same
 * quantity and had the same staleness — measured failing *open* on `d29a5bc` —
 * so it was a second instance of the bug rather than a precedent that made it
 * safe, and it is no longer cached either. Note that the `d29a5bc` measurement
 * found only one of its two directions: the same stale root fails *open* in
 * `classifyConfigDirPath`, where a non-matching root reads as "outside the
 * config dirs", and *closed* in `isReadableConfigDirPath`, where it reads as
 * "not readable". One mechanism, two polarities, so neither site's severity
 * sentence can be reused for the other.
 *
 * The cost is real and is paid per *allowed* decision, never on the rejected
 * path. See `allowOnlyIfResolvedFormsAgree`, which skips the written spelling
 * outright — not merely its fold — so a path with no symlinks in it does not
 * reach here at all.
 */
/**
 * Removes trailing separators from a fold root. Applied to **both** sides.
 *
 * Neither side gets this for free, and the two miss it for different reasons.
 * `normalize` only collapses *duplicate* separators — it **preserves** a single
 * trailing one — and `getPathsForPermissionCheck` adds the path as written
 * alongside its realpath, so a root that arrives with a trailing separator keeps
 * it on the `lexical` side and on at least one `resolved` form. (`realpath`
 * strips it, which is why the `rootLower + sep` prefix test is not the thing
 * that breaks first.)
 *
 * The consequence in `foldResolvedRootPrefix` is a doubled separator: the arm
 * that emits `lexical + sep + rest` produces `…/cfg//agent-memory`, which
 * matches no carve-out. Worse than not helping — because that root's resolved
 * form is *longer*, it wins longest-match and displaces a fold that would
 * otherwise have been clean.
 *
 * More than one root can arrive that way, so do not read this as special-casing
 * one entry. `getAutoMemPath()` ends in `sep` **by contract** — `validateMemoryPath`
 * strips any trailing separators and re-adds exactly one, and `isAutoMemPath`
 * prefix-matches against it — which is precisely why the separator is normalised
 * here, on the way in, rather than at the producer. `getClaudeConfigHomeDir()`
 * and `getMemoryBaseDir()` return their environment variable verbatim, so a user
 * trailing slash in `CLAUDE_CONFIG_DIR` reaches this function unaltered; note
 * those two are the same string unless `CLAUDE_CODE_REMOTE_MEMORY_DIR` is set,
 * so they are two sources but one value at the defaults.
 *
 * Returns `root` unchanged whenever the strip would empty it, so `''` and a
 * bare `/` both come back as they arrived. Be precise about what that guard
 * does, because an earlier version of this sentence was not: it keeps the
 * function total, it does not close a hole. An empty root is **inert**
 * downstream. Both root-matching sites normalise before comparing, and
 * `normalize('')` is `'.'` on posix and win32 alike — a relative spelling,
 * which cannot prefix-match an absolute candidate.
 *
 * Do not strike the claim that was here — that an empty root "prefix-matches
 * every absolute path" — because half of it is TRUE and it is the only stated
 * reason this guard exists. Measured over an eight-candidate battery, root `''`
 * against the **raw** matcher on `path.posix` matches **8 of 8**. What is false
 * is the consequence for the function as it actually runs, and the normalise
 * above is what makes it false.
 *
 * Do not credit a separator in the matchers with saving this one, and do not
 * paraphrase those matchers as `root + sep`. Both iterate
 * `ROOT_SEPARATOR_SPELLINGS`, which is `new Set([sep, '/'])` — one member on
 * posix, two on win32 — so `/` is tried as a separator on **both** flavours and
 * `'' + '/'` is `/`, which prefix-matches every candidate here. The empty root
 * matches **8 of 8** raw on posix *and* on win32. An earlier revision of this
 * paragraph said **0 of 8** for win32 and called the hazard POSIX-only; that is
 * the number the `root + sep` paraphrase predicts, not the one the code gives.
 * The separator covers `''` on neither flavour.
 *
 * A root of `/` is a separate case, and no longer the opposite extreme this
 * paragraph once made it. A root form that already ends in a separator spelling
 * takes the bare-prefix branch — see `endsWithSeparatorSpelling` — so `/`
 * matches every candidate, **8 of 8**, raw and as the code runs it, on both
 * flavours, rather than the **1 of 8** stated here before. That is deliberate
 * and is argued where the branch lives, not here; `/` only becomes a config-dir
 * root if the user sets `CLAUDE_CONFIG_DIR=/`, and these carve-outs withhold
 * allows rather than granting them.
 *
 * The safety is therefore real, **unowned, and single** — one undocumented
 * property of Node's `path`, the upstream `normalize`, which nothing here
 * names, tests or depends on deliberately. There is no spare: a refactor that
 * compares before normalising re-opens it at both sites at once, and no test
 * fails at either. An empty value is wrong for every consumer of
 * `getClaudeConfigHomeDir`, not just this one, so it belongs rejected at the
 * producer rather than absorbed here.
 *
 * This guard is narrower than the rule it is an instance of — see
 * `stripTrailingSeparatorsForWalk` — so do not reuse this function anywhere the
 * stripped value is resolved rather than concatenated.
 */
function stripTrailingSeparators(root: string): string {
  const stripped = root.replace(/[\\/]+$/, '')
  return stripped === '' ? root : stripped
}

/**
 * The same strip, for the side that feeds `getPathsForPermissionCheck` — with
 * the one exception where removing the separator changes what the string
 * *denotes* rather than just how it is spelled.
 *
 * The two sides genuinely want different answers for a path that denotes a
 * root, which is why this is a second function and not a widened guard on the
 * first:
 *
 * - The `lexical` side **must** strip. It emits `lexical + sep + rest`, so
 *   `C:\` would produce `C:\\rest`; `C:` produces `C:\rest`, which is right.
 * - This side **must not** strip, because the stripped form no longer names the
 *   same directory. Same polarity as the bug this strip was added to fix: a
 *   false deny — the chain walk is handed a different directory, so the root's
 *   resolved set stops containing the root.
 *
 * Read that second bullet over the whole population, not over `C:\` alone. The
 * drive root is only the easiest case to state: `C:` is drive-*relative* in
 * Windows, naming the current directory on drive C: rather than the drive root,
 * so the substitution is a different directory that still exists — which is
 * what makes it silent. The UNC and extended-length forms fail the same way for
 * a different reason: `\\server\share` and `\\?\C:` have lost the separator that
 * makes them a root at all. Three shapes, one rule — stripping changed what the
 * string denotes — and a guard written for only the drive case would let the
 * other two through.
 *
 * Two different things get called "root-only" around this function, and keeping
 * them apart is the whole of the reasoning below:
 *
 * - **denotes a root** — a property of the string itself. `C:\`, `C://`,
 *   `C:\\`, `C:////`, `C:\/`, `\\server\share\`, `\\server\share\\`,
 *   `\\?\C:\`, `//server/share//` and POSIX `/` all denote filesystem roots.
 * - **the predicate** — the boolean the last line of this function *tests*:
 *   *"does the stripped form plus one separator spell a root?"* Not the value
 *   that line returns, which is a string; the two are easy to conflate because
 *   one expression contains the other.
 *
 * An earlier revision of this paragraph said they agree on every spelling above
 * except `/`. Restricted to the ten spellings in the first bullet that is true,
 * and the restriction was doing silent work, because the disagreements live
 * mostly *outside* that list. Measured over the list plus the inputs it omits,
 * the two senses disagree on `/`, `//`, `///`, `C:` (and `c:`) and `''` under
 * `path.win32`, and on `/`, `//`, `///` and `''` under `path.posix`.
 *
 * Read `C:` first, because it is not an exotic input: it is the exact value the
 * *old* predicate produced by stripping `C://`. It denotes no root —
 * `normalize('C:')` is `C:.` and `isAbsolute('C:')` is false, so it is
 * drive-relative and resolving against it pulls in the process working
 * directory — and the predicate calls it a root anyway, because `C:` plus one
 * separator spells `C:\`. That is the outcome this function wants, reached
 * through a sense the second bullet does not claim. It is the sharpest reason
 * not to read the predicate as a test for denotation anywhere else.
 *
 * `/` **denotes a root and fails the predicate**, because
 * `stripTrailingSeparators('/')` returns `/` unchanged through its own
 * empty-string guard, so the predicate is asked about the stripped form plus a
 * separator — `/\` under `path.win32`, `//` under `path.posix` — and neither
 * of those spells a root. The input is returned verbatim either way, by the
 * sibling's guard rather than by this test. `//` and `///` fail the same way,
 * and on **both** flavours — they are not a POSIX-only artefact. Worth saying,
 * because when a claim about this function splits by flavour the reflex is to
 * assume win32 is the exception, and here it is not.
 *
 * They disagree on `''` as well. Do not write that one off as unreachable: a
 * set-but-empty `CLAUDE_CONFIG_DIR` has reached `getClaudeConfigHomeDir()` and
 * come back as `''`, because a null-ish fallback treats `export X=` and
 * `unset X` differently while a shell does not. Whether that is still true when
 * you read this depends on the guard *there* — check `getClaudeConfigHomeDir`,
 * not this function, and do not encode the answer here, because a sentence
 * about someone else's operator is a sentence that rots. What this function can
 * say for itself is the weaker and durable half: the disagreement is inert
 * here, since `''` is returned verbatim, which is the answer a plain strip
 * gives too. It is not inert downstream, which is why the guard lives upstream
 * of both of us rather than in either.
 *
 * Every claim below says which of the two senses it is in, because a sentence
 * that is true in one of them is not evidence for the other, and the superseded
 * version of this comment used the single phrase "root-only" for both across
 * fourteen sites in this file — re-derived at `origin/main`, one occurrence per
 * line, not inherited. Thirteen is the number you get from a docblock-scoped
 * pass, and it is wrong: the fourteenth is a `//` comment in
 * `getFoldableRootsForSession`'s **body**, at the second of the two strips.
 * Two further clauses are driven by the same equivocation without containing
 * the phrase, so scope the sweep by meaning and not by string, and expect two
 * passes rather than one.
 *
 * The predicate is deliberately not a `/^[A-Za-z]:$/` regex: it covers UNC
 * share roots (`\\server\share\`) and extended-length prefixes (`\\?\C:\`) as
 * well as drive roots, each of which loses meaning the same way. It does not
 * need to cover POSIX `/`: that one does reach the strip, but the sibling's
 * guard hands it back unchanged before this test can matter.
 *
 * It is also deliberately **not** `parse(root).root === root`, which is what
 * this function asked until Copilot found the hole. That predicate tests for a
 * *canonically spelled* root, not for a root — so every redundant spelling
 * failed it and fell through to the strip, which is the one outcome this
 * function exists to prevent. `C://`, `C:\\`, `C:////` and `C:\/` all became
 * drive-relative `C:`, and `\\server\share\\`, `\\?\C:\\` and
 * `//server/share//` lost the root separator — seven spellings, of which the
 * forward-slash UNC form is the one most easily missed, since every other UNC
 * spelling here is written with backslashes. Asking about the stripped form
 * instead moves the question off the spelling, so the input can be returned
 * verbatim.
 *
 * **Do not simplify this to `normalize(root)`.** It looks equivalent and is
 * not: `normalize` folds `..` lexically, which is not symlink-safe, and this
 * value is handed straight to a chain walk — `/cfg/../` becomes `/`, so a root
 * the user pointed inside their home silently becomes the filesystem root,
 * without either `..` hop being checked against what the links actually
 * resolve to. It re-spells canonical input too (`c:/` -> `c:\`, and on win32
 * `/` -> `\`), which defeats the whole point of returning root spellings
 * verbatim.
 *
 * The superseded comment justified the sibling's empty-string guard with "an
 * empty root prefix-matches every absolute path", and the correction is finer
 * than striking it. Both matchers test `cand === root`, then — for a root form
 * that already ends in a separator spelling — a bare `cand.startsWith(root)`,
 * and otherwise `cand.startsWith(root + s)` for every `s` in
 * `ROOT_SEPARATOR_SPELLINGS`. Do not shorten that to `root + sep`: the set is
 * `new Set([sep, '/'])`, so it has two members on win32 and one on posix, and
 * the short form is false on win32 while staying true on posix — the flavour a
 * darwin/Linux host checks casually is exactly the one that hides the
 * difference.
 *
 * The eight candidates, enumerated so that no number below rests on a battery
 * the reader cannot rebuild. All are `/`-spelled, which is what both a posix
 * host and a hand-set `CLAUDE_CONFIG_DIR` produce:
 *
 *   /                                        /cfg2
 *   /cfg                                     /home/u/.axa
 *   /cfg/agent-memory                        /home/u/.axa/settings.json
 *   /cfg/agent-memory/axa-tools/MEMORY.md    /tmp
 *
 * Measured over them, against the matcher as spelled out above:
 *
 * - Root `''`, `path.posix`, raw predicate: **8 of 8**. The sentence is TRUE,
 *   and it is the only stated reason that guard exists — do not delete it.
 * - Root `''`, `path.win32`, raw predicate: **8 of 8** as well. An earlier
 *   revision said **0 of 8** and called the catastrophe POSIX-only, reasoning
 *   that `'' + sep` is `\` while the candidates are `/`-spelled. That follows
 *   from the `root + sep` short form; the real matcher also tries the `/`
 *   member of `ROOT_SEPARATOR_SPELLINGS` on win32, so the POSIX result does
 *   transfer after all.
 * - Root `''`, either flavour, as the code actually runs it: **0 of 8**. Both
 *   sides are normalized — the callers are `relativeToConfigDirRoot(
 *   normalize(form), roots)` and the parameter is named `normalizedPath`, and
 *   the fold site matches against `normalizedForm` — and `normalize('')` is
 *   `'.'` on both flavours, so `./` prefix-matches no absolute path.
 * - Root `/`, every configuration above: **8 of 8**. An earlier revision said
 *   **1 of 8**, "itself and nothing else". That was true of the older matcher,
 *   which appended a second separator to a root already ending in one and so
 *   tested `//`; the root-only branch matches such a root as a bare prefix
 *   instead. See `endsWithSeparatorSpelling`.
 *
 * Controls for the normalize step, taken in the same run and in the same
 * both-sides configuration as the row above: root `/cfg//` moves **0 -> 2 of
 * 8** across it on both flavours, while root `/cfg` stays at **3 of 8**. One
 * row that moves and one that does not, because a control that always moves
 * shows only that the instrument is live, not that it discriminates. The
 * control this paragraph used to cite — `/cfg` on win32, 1 -> 2 of 8 — is inert
 * against the current matcher, so re-taking it as written would publish a dead
 * control.
 *
 * So `''` and `/` are not the two extremes of this battery any more: both match
 * every candidate raw, and only the normalize separates them. What holds the
 * empty root harmless is a **single** undocumented property of *other* code,
 * that upstream `normalize`. This paragraph previously offered two — "the `+
 * sep` in the matcher and the upstream `normalize`, either of which alone
 * suffices" — and the first arm covers `''` on neither flavour. There is no
 * spare, so a refactor that drops the normalize opens the hole with nothing
 * failing, and a comment promising a redundancy that is not there is a
 * fail-open in the documentation. The same shape holds at both matchers,
 * `relativeToConfigDirRoot` and `foldResolvedRootPrefix`. The guard is what
 * makes the question moot; the conclusion above survives on its other three
 * reasons regardless.
 *
 * Measured with `path.win32` — note that `parse` **and** `sep` are both
 * platform-bound, so a host-independent check has to substitute both. The
 * battery above needs a **third** substitution that this table does not:
 * `ROOT_SEPARATOR_SPELLINGS` is built from `sep` at module load, so it does not
 * follow a flavour swapped in afterwards, and a probe that swaps only `parse`
 * and `sep` measures the host's separator set against the other flavour's
 * paths —
 *
 * The rows below were taken in one run of one instrument, so that no number
 * here is spliced together from two. They do not exhaust the spellings named
 * above: `//`, `///`, `C:`, `c:` and `''` are read in the prose after the
 * table instead, and the paragraph on the `/` row says why the first two are
 * not folded into it:
 *
 *                        denotes root   predicate   result
 *   C:\                  yes            true        verbatim
 *   C://                 yes            true        verbatim
 *   C:\\                 yes            true        verbatim
 *   C:////               yes            true        verbatim
 *   C:\/                 yes            true        verbatim
 *   \\server\share\      yes            true        verbatim
 *   \\server\share\\     yes            true        verbatim
 *   \\?\C:\              yes            true        verbatim
 *   \\?\C:\\             yes            true        verbatim
 *   //server/share//     yes            true        verbatim
 *   /                    yes            FALSE       verbatim (via sibling)
 *   C:\cfg\              no             false       -> C:\cfg
 *   \\server\share\sub\  no             false       -> …\sub
 *   /cfg/                no             false       -> /cfg
 *
 * The `denotes root` column is measured on `parse(normalize(p)).root ===
 * normalize(p)` and not on `parse(p).root === p`. That matters, because the
 * naive form is the discarded predicate from two paragraphs up, and it
 * disagrees with the canonical one on 7 of these 14 rows — including
 * `//server/share//`, which it calls "not a root". Measuring denotation with a
 * spelling-sensitive instrument reproduces the exact bug this function exists
 * to fix, inside the evidence for the fix.
 *
 * Those 7 disagreeing rows are, measured, the same 7 spellings listed as the
 * defect above, and that is not a coincidence to be re-derived next time: the
 * naive instrument *is* the old predicate, so the rows it gets wrong are by
 * construction the rows the old predicate got wrong. If the two sets ever come
 * apart, one of them was mis-measured.
 *
 * The `/` row is the one to read twice: it is the only row *in this table* where
 * the two columns disagree, and it is the input every wrong sentence this
 * comment has carried was about. Do not read that as "the only disagreement" —
 * the table is a sample and the full set is enumerated above, including `C:`,
 * `c:` and `''`, which disagree the *other* way (denote no root, satisfy the
 * predicate), and `//` and `///`, which disagree the same way `/` does.
 *
 * Those two are deliberately **not** folded into the `/` row as an
 * "all-separator" family, even though this function treats all three alike:
 * each denotes a root, fails the predicate, and comes back verbatim through the
 * sibling's guard. Measured, they part company on the *other* instrument — the
 * naive `parse(p).root === p` calls `//` and `///` not roots, while it agrees
 * with the canonical form about `/`. A family row would therefore be
 * heterogeneous in the `denotes root` column and would move the "7 of these 14"
 * count above, which is measured over the rows exactly as they are written.
 *
 * The controls matter: without them the predicate could be one that is simply
 * always true, and the whole strip would be dead. Hard-wiring it to false
 * moves 10 of these 14 rows, so it is load-bearing rather than decorative, and
 * no row that denotes a root is re-spelled.
 *
 * The superseded comment carried the proof of its own equivocation right here,
 * which is the cheapest way to see why the two senses had to be named apart. Its
 * table labelled **7** rows `root-only`, and the paragraph two lines below it
 * said hard-wiring the predicate to false moves **6** of them. Under one meaning
 * of `root-only` those numbers must match. They differ by exactly `/` — the row
 * that denotes a root and fails the predicate — so the mismatch *is* the two
 * senses, sitting four lines apart. The sentence
 * after it, "no root-only row is re-spelled", is true under both senses; a true
 * neighbour is what let the inconsistent pair look settled.
 *
 * **On POSIX this function is a no-op for every input**, which bounds what any
 * darwin/Linux fixture can show. That is a property of the predicate and not a
 * result over a sample, so state it as the argument rather than as a count:
 * on `path.posix` the predicate can only be true when the stripped form plus
 * `/` spells a root, i.e. when the stripped form is empty — and
 * `stripTrailingSeparators` returns the empty string for exactly one input,
 * the empty string, for which a plain strip gives the same answer anyway.
 * Every other POSIX input, `/` and `//` included, fails the predicate and is
 * returned by the sibling's guard or by the strip. So this function and a
 * plain strip agree everywhere under `path.posix` and diverge only under
 * `path.win32`.
 *
 * Say **10 of the 14** for that win32 divergence, not seven. Seven is the
 * defect list — the spellings the *old* predicate got wrong — and this is the
 * different quantity flagged immediately below: against a plain strip the
 * canonically spelled roots `C:\`, `\\server\share\` and `\\?\C:\` move too,
 * even though the old predicate already handled them. Every root-denoting row
 * moves except `/`, which the sibling's guard reaches first.
 *
 * Two counting traps, both of which have already been walked into here. There
 * are *three different quantities* in play — this function versus a plain
 * strip, this function versus its previous shape, and rows moved by disabling
 * the predicate — so a bare "differs N times" is unreadable without saying
 * which pair it compares. And `/` denotes a root yet does **not** differ from
 * a plain strip, because the sibling's guard reaches it first; counting it as
 * a difference is how the superseded version of this comment claimed 4
 * differences over a battery that had 3. That sentence is a trap in the other
 * direction too: as written above it is a claim about denotation and it is
 * true, but the same words read in the predicate sense are false, and nothing
 * in them says which. A true sentence is not a safe sentence to align its
 * neighbours to — check that it means what they mean before using it as the
 * anchor.
 *
 * The corollary is that the end-to-end permission effect is **not reproducible
 * on a POSIX host** — the permission battery and the symlink fixtures are
 * byte-identical across every change to this function, which is the expected
 * reading and not evidence the guard works. What is measured here is the
 * predicate; what is reasoned is the consequence of handing `C:` to a chain
 * walk.
 *
 * The old guard is not this function's rule restricted to POSIX — it is a
 * different test that happens to cover the one POSIX case. It fires on exactly
 * one stripped value, the empty string, which is why `/` survives it; this
 * function's predicate is false for `/` and contributes nothing there. Both
 * guards are instances of one underlying rule — do not strip when the strip
 * changes what the string denotes — but the old one states a symptom ("never
 * strips to the empty string") rather than the reason; a Windows drive root is
 * the same defect with a non-empty remainder, which is why the symptom-shaped
 * guard did not catch it.
 *
 * Reachability is narrow and real: `join(…, CONFIG_DIR_NAME)` and
 * `getClaudeTempDir()` both append a component and so can never denote a root.
 * The population is a user pointing `CLAUDE_CONFIG_DIR`,
 * `CLAUDE_CODE_REMOTE_MEMORY_DIR` or the auto-memory dir at a drive or share
 * root, since those reach this function as typed.
 */
function stripTrailingSeparatorsForWalk(root: string): string {
  // `stripTrailingSeparators` returns the empty string for one input — the
  // empty string — and `'' + sep` spells a root, so that input satisfies the
  // predicate below without denoting a root. It is returned verbatim, which is
  // the same answer a plain strip gives, so the disagreement is inert here; it
  // is not inert in the sibling, whose own guard exists for it. The POSIX root
  // reaches the strip branch and is returned unchanged by that guard rather
  // than by the test below.
  const stripped = stripTrailingSeparators(root)
  const withOneSeparator = stripped + sep
  return parse(withOneSeparator).root === withOneSeparator ? root : stripped
}

type FoldableRoot = { lexical: string; resolved: string[] }

function getFoldableRootsForSession(): FoldableRoot[] {
  return (
    // Deduped because the pairs collapse in the common case:
    // getMemoryBaseDir() === the config home unless CLAUDE_CODE_REMOTE_MEMORY_DIR
    // is set, and the two project config dirs are equal until the session
    // changes directory. Deduping keeps the usual cost at five resolutions.
    [
      ...new Set([
        getClaudeConfigHomeDir(),
        getMemoryBaseDir(),
        join(getOriginalCwd(), CONFIG_DIR_NAME),
        join(getCwd(), CONFIG_DIR_NAME),
        getPlansDirectory(),
        getAutoMemPath(),
        // getClaudeTempDir() is the one root here that looks like it does not
        // belong, because it advertises itself as already resolved. It is not:
        // it realpaths only its *base* and then joins `claude-{uid}` lexically,
        // so a link at that tail component leaves the root as lexical as the
        // config home.
        //
        // It also always ends in a separator: the body is
        // `join(resolvedBaseTmpDir, getClaudeTempDirName()) + sep`, with no
        // branch. Do not group that with the trailing separators the two
        // env-backed roots above *can* carry — those need a user to type a
        // slash into CLAUDE_CONFIG_DIR, this one needs nothing. An earlier
        // version of this comment said `getClaudeTempDir()` "also" returns one,
        // and the grouping is what made the separator handling below read as an
        // edge case for a misconfigured setup. It is not: one root is in that
        // state on every run, on every platform.
        getClaudeTempDir(),
      ]),
    ].map(root => ({
      lexical: stripTrailingSeparators(normalize(root)),
      // The strip is on the ARGUMENT, and that is the whole point — stripping
      // only the results cannot work, because by then the forms are already
      // missing. `getPathsForPermissionCheck` walks the symlink chain with
      // `lstat`/`readlink`, and POSIX makes a trailing separator *follow* the
      // link: `lstatSync('hop/').isSymbolicLink()` is false where
      // `lstatSync('hop')` is true, and `readlinkSync('hop/')` fails EINVAL.
      // (Control: a real directory also reports false, so the value
      // discriminates rather than being constant.) So a root that arrives with
      // a separator makes the walk terminate on its first step; the
      // intermediate hops are never collected, and only the final realpath
      // survives via the fallback. Nothing downstream restores a form that was
      // never gathered.
      //
      // This is not hypothetical and it is not conditional. `getClaudeTempDir()`
      // ends in `sep` unconditionally, so before this strip that root's resolved
      // set was wrong in every session. The observable consequence was a false
      // *deny*: a candidate that is itself a symlink to the intermediate hop
      // folded to nothing, disagreed with its own written spelling, and
      // `allowOnlyIfResolvedFormsAgree` returned passthrough where it had
      // previously allowed.
      //
      // Both strips are therefore load-bearing and they are not the same call
      // twice: this one decides which forms exist, the one on `lexical` decides
      // what they are folded back to. They are also not the same *function*, and
      // that is not an oversight — a path that denotes a root is the one input
      // where the two sides want opposite answers. See
      // `stripTrailingSeparatorsForWalk`.
      resolved: getPathsForPermissionCheck(
        stripTrailingSeparatorsForWalk(root),
      ).map(form => stripTrailingSeparators(normalize(form))),
    }))
  )
}

/**
 * Rewrites a resolved form back into the lexical spelling of whichever root
 * contains it, longest root first. Returns the form unchanged when no root
 * does.
 *
 * This is the second half of "expand both sides". `getPathsForPermissionCheck`
 * expands the candidate; without a matching expansion of the roots, a config
 * dir reached through a symlink (`CLAUDE_CONFIG_DIR=/tmp/link -> /tmp/real`,
 * or a symlinked `$HOME`) resolves to a spelling no carve-out recognises, and
 * legitimate writes and reads turn into denials. Folding is what expanding the
 * root side reduces to once it is pushed onto the candidate, and it fixes the
 * class in one place rather than one predicate at a time.
 *
 * **23 decision cells across 15 paths and 9 carve-outs** were measured to
 * regress without this, each confirmed by turning the fold off and watching the
 * cell drop to `passthrough`: `isAgentMemoryPath` (user, project and local
 * scope), `isSessionPlanFile`, `isSessionMemoryPath`, `isProjectDirPath`, the
 * tool-results directory, tasks, teams, `launch.json`, and the project temp dir.
 *
 * That count carries its fixture, because a count without one is an assertion.
 * It is from a single harness that varied: config root canonical vs symlinked,
 * `CLAUDE_CODE_REMOTE_MEMORY_DIR` canonical vs symlinked, `getCwd()` equal to
 * vs divergent from `getOriginalCwd()`, and the `claude-{uid}` temp component
 * canonical vs symlinked. An independent fixture (audit-2-2's) reproduced the
 * 9 carve-outs and 13 of the cells and explicitly declined to restate the rest
 * as its own; a reader who reproduces 13 has not found an inflated number, they
 * have found a smaller instrument. Two cells in the count are configuration-
 * dependent and should be looked for in the right place: the `launch.json` and
 * project-scope agent-memory pair separates only once the session changes
 * directory, and the tool-results cell fires only there too — `isProjectDirPath`
 * tests `getProjectDir(getCwd())` and is checked *earlier* in
 * `decideReadableInternalPath`, so with the default `cwd === originalCwd` a
 * tool-results path is answered with the project-dir reason and the tool-results
 * block never runs at all.
 *
 * Treat that as a floor, not a total. The fold keys on the **root**, not on the
 * carve-out, so it repairs every carve-out rooted at any of the roots
 * `getFoldableRootsForSession` returns — not `getClaudeConfigHomeDir()` alone —
 * whether or not a fixture ever exercised it; enumerating the repaired set is
 * therefore a matter of reading roots, not of counting rows. That is the
 * argument for folding over expanding roots inside N predicates: the N-predicate
 * route repairs exactly the predicates someone thought to change.
 *
 * A caution about the counting, because it cost three of us a wrong conclusion.
 * Five of those cells only appear once the fixture builds a path at the exact
 * shape the predicate demands — `isSessionPlanFile` needs a `<planSlug>*.md`
 * filename, and the other three carve-outs need
 * `<cfg>/projects/<sanitized-cwd>/<sessionId>/…`
 * to exist. With a generic filename the plans row does not fire at all: both
 * forms fall through to the config-dir arm, both come back with the same reason
 * string, and the row agrees for a reason that has nothing to do with plans. It
 * reads as a survivor and is really a dead row. Being under an *open*
 * config-dir subtree does not rescue a carve-out — `agent-memory` and `plans`
 * are both in `CONFIG_DIR_OPEN_DIRS` and `agent-memory` regresses — because the
 * fallback allows with a *different* reason string and the loop below compares
 * reasons, not behaviours. What varies between rows is only whether the specific
 * carve-out fires at all.
 *
 * It cannot launder an escape, and it is worth being exact about *why*, because
 * the obvious answer is wrong. The obvious answer — that it only ever
 * substitutes a prefix and never invents a relative segment — has an unstated
 * premise: that the substituted prefix still aliases the original. A stale root
 * breaks that premise, and when this function cached its roots that was a
 * demonstrated way to mint an allow (see `getFoldableRootsForSession` above).
 * Prefix-only substitution is a necessary property, not a sufficient one.
 *
 * The sufficient one is upstream: `allowOnlyIfResolvedFormsAgree` takes the
 * decision for the path **as written**, unfolded, and only consults resolved
 * forms if that decision was already an `allow` of a known identity. So folding
 * can never *promote* a path — it can only take an already-granted allow away.
 * Within that gate the rest follows: a form that resolves outside every root
 * keeps no root prefix and so is decided literally; a form that resolves to a
 * *different* path under the same root is folded to its true relative path and
 * gets its true classification, which for `sessions/` or `history.jsonl` is not
 * an allow.
 *
 * The load-bearing part is that the folded string is then *re-decided* by the
 * whole carve-out chain, not by the carve-out that admitted the path as
 * written. So a rewritten spelling can match a *different* carve-out than the
 * one the caller aimed at — `<cfg>/plans/link.md -> <cfg>/agent-memory/x.md`
 * folds into the agent-memory namespace and comes back with *that* carve-out's
 * reason.
 *
 * What happens next is a **denial**, and an earlier version of this paragraph
 * said the opposite. It claimed re-deciding "can change which allow is granted",
 * which the consumer refutes: `allowOnlyIfResolvedFormsAgree` compares reasons,
 * and on a mismatch returns `denied` — while on success it returns `decision`,
 * the *written* form's result. A different allow is never granted. The
 * docblock's own worked example measures `passthrough`, with controls showing
 * that a same-carve-out symlink allows, the unlinked path allows, and the target
 * allows under its own name — so the denial is the identity check firing and not
 * a dead fixture. Two other paragraphs here already said so; this one was the
 * cheapest sentence in the file to falsify and the one that was wrong.
 *
 * Which makes reason **distinctness** a third unenforced convention, alongside
 * the two named at the loop. `identify` treats the reason string as the
 * carve-out's identity, so two carve-outs sharing a string would be one identity
 * to this check, and a path allowed by A whose resolved form lands in B would
 * *agree* instead of being denied. That fails **open**. All 19 reasons are
 * distinct today, but the margin is one word — "Project directory files are
 * allowed for reading" against "Project temp directory files are allowed for
 * reading" — and a new carve-out is written by copying a neighbouring block,
 * where the reason line is the one most likely to be left alone. A duplicate
 * would still be a static literal and would still satisfy the convention that
 * *is* written down.
 *
 * `roots` is a required parameter with no default, deliberately. A default of
 * `getFoldableRootsForSession()` would read as harmless and would let a future
 * caller reintroduce a per-form realpath sweep without writing anything that
 * looks like a cost — see the sole call site, which resolves them once per
 * decision precisely to avoid that.
 */
function foldResolvedRootPrefix(form: string, roots: FoldableRoot[]): string {
  const normalizedForm = normalize(form)
  const formLower = normalizeCaseForComparison(normalizedForm)
  let folded: string | undefined
  let foldedRootLength = -1
  for (const { lexical, resolved } of roots) {
    for (const rootForm of resolved) {
      // Longest matching root wins, and this is load-bearing rather than
      // defensive — but not for the reason an earlier draft of this comment
      // gave. That draft justified it with `cwd` ⊃ `cwd/.axa`, a nesting that is
      // not in the root set at all. The nestings that *are* (plansDir and
      // getAutoMemPath() inside the config home) cannot observe the rule either:
      // there the inner root's lexical spelling is the outer's plus a suffix, so
      // both candidate folds emit the same string.
      //
      // The configuration that observes it is two *different* links resolving
      // into one another: CLAUDE_CONFIG_DIR -> <realcfg> together with
      // CLAUDE_CODE_REMOTE_MEMORY_DIR -> <realcfg>/mem. A form under
      // <realcfg>/mem/agent-memory then matches both roots, and only the longer
      // one folds it to a spelling `isAgentMemoryPath` accepts. Inverting this
      // line to shortest-wins drops that row from `allow` to `passthrough`,
      // which is the control that makes the claim a measurement.
      //
      // The comparison is across *different* roots and uses the length of the
      // **resolved** form, which is the side the candidate is matched against.
      // `<=` sends ties to the earlier root in the list above; a tie means two
      // roots resolve to the same directory, so the two folds differ only in
      // which lexical spelling of that one directory comes back.
      //
      // `relativeToConfigDirRoot` is the same walk over the same shape and now
      // resolves overlap the same way. It did not always: it returned on the
      // first match, and its own docblock records what that cost — the two
      // functions being out of step here was a live fail-open, not a stylistic
      // difference. Change one of them and check the other.
      if (rootForm.length <= foldedRootLength) continue
      const rootLower = normalizeCaseForComparison(rootForm)
      if (formLower === rootLower) {
        folded = lexical
        foldedRootLength = rootForm.length
        continue
      }
      // Same doubled-separator hole as `relativeToConfigDirRoot`, fixed the same
      // way — see `endsWithSeparatorSpelling` for the measurement and for why
      // this site's population is narrower: the resolved forms here are stripped
      // afterwards, so only the all-separator root (`/`, or `\` on win32)
      // reaches this loop with a trailing separator.
      //
      // The emit needs its own guard because `lexical` is stripped by the same
      // function and so can also be all-separator. Control, with the guard
      // hard-wired off: an unlinked `CLAUDE_CONFIG_DIR=/` folds
      // `/agent-memory/x.md` to `//agent-memory/x.md`, a spelling no carve-out
      // recognises. With it, that row is a no-op — lexical and resolved are the
      // same string, so there is nothing to rewrite — and the one row that moves
      // is a root whose lexical spelling differs from a root-only resolved form:
      // `CLAUDE_CONFIG_DIR=/link -> /` now folds `/agent-memory/x.md` to
      // `/link/agent-memory/x.md` instead of leaving it unfolded.
      //
      // That direction is **closed**, checked here rather than carried over from
      // the other site: an unfolded form is re-decided literally, matches no
      // carve-out, and `allowOnlyIfResolvedFormsAgree` turns the reason mismatch
      // into `denied`. No allow can be minted either way — that gate only ever
      // downgrades the written form's decision.
      if (endsWithSeparatorSpelling(rootForm)) {
        if (formLower.startsWith(rootLower)) {
          folded =
            lexical +
            (endsWithSeparatorSpelling(lexical) ? '' : sep) +
            normalizedForm.slice(rootForm.length)
          foldedRootLength = rootForm.length
        }
        continue
      }
      for (const s of ROOT_SEPARATOR_SPELLINGS) {
        if (formLower.startsWith(rootLower + s)) {
          folded =
            lexical + sep + normalizedForm.slice(rootForm.length + s.length)
          foldedRootLength = rootForm.length
          break
        }
      }
    }
  }
  return folded ?? normalizedForm
}

/**
 * Runs a carve-out chain against every resolved form of `absolutePath` and only
 * keeps an `allow` that survives all of them.
 *
 * Most carve-outs below match on the path *as written* — a prefix, a filename
 * suffix, an exact string — and do not look at what the path resolves to, so
 * a symlink placed at an accepted name launders a write or read to its target:
 * `agent-memory/x.md -> ~/.ssh/authorized_keys` is allowed as an agent-memory
 * file.
 *
 * Counted by reading rather than by fixture: the write and read carve-out
 * chains hold **19 allow-returning decision sites** (7 write, 12 read), which
 * dedupe to **14 distinct carve-outs** — five (plans, scratchpad, agent memory,
 * auto memory and the config dir) appear in both chains. **Twelve of the 14
 * were laundering-exploitable; 16 of the 19 sites were.**
 *
 * "Chains" rather than "these two functions" on purpose: the numbers are
 * measured on `d29a5bc`, where `decideEditableInternalPath` and
 * `decideReadableInternalPath` do not yet exist — `dd51aad` extracted them out
 * of the `check*InternalPath` pair. All 19 `reason` strings are present at
 * `d29a5bc` unchanged, verified independently from both sides, so the
 * population transfers across the extraction 1:1 with nothing added or merged.
 *
 * Count in **sites**, not in observed arms. A site is a lexical `allow` return
 * and each of the 19 carries a distinct `reason`, so sites and identities
 * correspond one-to-one and the count is configuration-independent. Which site
 * a given path actually *reaches* is not: with `tengu_scratch` off a
 * scratchpad path falls past its own site to the project-temp-dir site below
 * it and is allowed under that reason instead, and with
 * `getCwd() === getOriginalCwd()` the tool-results path is taken by
 * `isProjectDirPath` earlier in the read chain. An independent fixture
 * measured 16 exploitable arms in the maximal configuration, where the two
 * counts coincide, and 13 arms over 15 sites at the defaults. Quoting an arm
 * count without both of those conditions is what made an earlier version of
 * this docblock say "fourteen" with no configuration attached.
 *
 * Two carve-outs already resolved both sides, and they are the argument for
 * putting this one screen ahead of all of them rather than bolting a check onto
 * each:
 *
 * - `classifyConfigDirPath` (the read and write config-dir sites) loops
 *   `getPathsForPermissionCheck` and returns `'outside'` if any form escapes —
 *   this function's rule, applied to one carve-out. Its own docblock already
 *   names the job-dir block as its model ("Same guard as the template job
 *   directory above"), and both predate this branch. **Measured**: the
 *   legitimate row allows, so the site is reachable rather than silent, and
 *   both symlink attacks are denied.
 * - the TEMPLATES job-dir block. **By reading only** — `feature('TEMPLATES')`
 *   is a `bun:bundle` import and is false under bare `bun`, so that site never
 *   fires in a fixture. A site that never fires is silence, not a negative
 *   control, and it is the one figure here that no measurement backs.
 *
 * **Do not enumerate this by grepping these two functions.** `grep` for
 * `getPathsForPermissionCheck`/`realpathSync` inside the two spans matches the
 * job-dir block and nothing else, because the config-dir guard lives one call
 * away in the callee. It returns a hit, so it reads as having worked, and it
 * hides the very carve-out that is the existence proof for this design. Two
 * successive versions of the count above were wrong through exactly that.
 *
 * All 16 close *here*, measured per commit in the maximal configuration: 16 on
 * `d29a5bc`, 0 once this function exists, 0 at every commit after. The fold
 * below closes none of its own — it exists to stop this function false-denying
 * on a root that is not spelled canonically. Anything crediting the fold with
 * the closure has the attribution backwards.
 *
 * A per-carve-out fix is N places that must each stay correct, and carve-out
 * N+1 would be written without one. The config-dir guard is the proof in both
 * directions: it is simultaneously the carve-out that got this right and, by
 * sitting one frame below the obvious instrument, the reason a hand-maintained
 * count of the others drifted twice.
 *
 * Two properties are load-bearing:
 *
 * - The whole chain re-runs per form, not one predicate. Carve-outs that
 *   combine a root with a filename test (plan files) or match a single exact
 *   path (`launch.json`) cannot be expressed as "is the target under this
 *   root", so a containment helper parameterised by a root — the shape the
 *   TEMPLATES job-dir block below uses — cannot cover them.
 * - Agreement is on `decisionReason.reason`, not on `behavior === 'allow'`.
 *   These trees nest, so requiring only `allow` would wave a link through
 *   whenever its *target* is cleared by a different carve-out than its own name
 *   was. Matching the reason is what ties the target back to the specific
 *   carve-out that admitted the link.
 *
 *   **Comparing reasons is only a sound proxy for comparing decisions because
 *   every `reason` in the two chains is a static literal**, so it depends on
 *   *which* carve-out fired and never on the path that reached it. All 19 are —
 *   7 in the write chain, 12 in the read chain, and all 19 distinct. This is a
 *   convention, not something the types enforce, and it is the kind that is
 *   discovered only after it breaks. Interpolate a path into one `reason` — for
 *   better diagnostics, which is the plausible motive — and two spellings of the
 *   same file stop yielding the same identity: the loop below reads that as a
 *   disagreement and a legitimate allow silently becomes `passthrough`. Nothing
 *   throws, no test names it, and the change that breaks it need not touch this
 *   function, the fold above, or anything a reviewer of *that* diff would think
 *   to look at. Keep them static, or change the comparison in the same commit.
 *
 * The reason rule has a deliberate cost, and it is the one thing here most
 * likely to be reported as a bug. **A symlink at a name one carve-out admits,
 * pointing at a file another carve-out admits, is denied even though both
 * endpoints are individually allowed.** Enumerating every ordered pair of
 * distinct carve-outs puts that at order-of-tens of pairs, not two or three, so
 * it is a category rather than a corner. It is accepted because matching on
 * `behavior` alone — the only alternative that admits them — is exactly the
 * unsound rule above. In practice nothing links `tasks/` at `teams/`; the single
 * plausible pair is agent-memory against the config dir, and the realistic
 * dotfiles case links *outward*, which this denies as a security fix regardless.
 *
 * The decision for the path as written is taken first and returned unchanged
 * unless a resolved form disagrees. On a canonical config root that makes this
 * purely narrowing — a path that is not a symlink resolves to itself and
 * reaches the identical result. It is *not* narrowing-by-construction, and the
 * earlier claim here that it was is what `foldResolvedRootPrefix` above exists
 * to repair: when the config root is itself reached through a link, resolution
 * hands the chain a spelling the carve-outs never see, and the disagreement is
 * between two spellings of the same file rather than between a link and its
 * target. Measured, that denied 23 decision cells across 9 carve-outs. Every
 * resolved form is therefore folded back onto the lexical root before it is
 * decided, so the comparison is like-for-like on both sides.
 *
 * Cost, measured rather than estimated, and attributed to the right change —
 * an earlier draft of this comment charged the fold with the *chokepoint's*
 * cost, because the figure was taken against `d29a5bc` rather than against the
 * commit below. Per allowed decision, µs/call, every cell from one harness and
 * min-of-three:
 *
 *                              canonical root   root via a symlink
 *   d29a5bc (no chokepoint)         80.5             87.0 (wrong answer)
 *   chokepoint, fold disabled      173.0             false denial
 *   + this fold                    171.8            366.0
 *   + identity-form skip            92.1            273.9   <- current
 *
 * Read the second row's right-hand cell as a *refusal*, not a missing number.
 * With the fold disabled the symlinked case comes back `passthrough`, so there
 * is no allowed decision there to time; an earlier table printed 277µs in that
 * cell, which was the cost of the denial, labelled as though it were the cost
 * of an allow. Timing a row without first asserting it is still an `allow` is
 * how that happened, and the harness now aborts instead.
 *
 * Every cell was re-measured together because the original harness was not
 * kept, and patching one cell of a table from a second instrument is the same
 * error in a smaller package. Absolute values are ~10-15% above the earlier
 * table's on this machine; the shape is what reproduces, and the shape is the
 * claim.
 *
 * So the chokepoint costs ~+91µs before the skip and ~+12µs after it, and this
 * fold is free to the limit of measurement on a canonical root — 173.0 vs
 * 171.8 is noise, and the fold is ordered *after* the identity-form skip below,
 * so a path with no symlinks never resolves a root at all. The remaining
 * ~+187µs is paid only when the config root is itself a link, only on decisions
 * already going to be allowed, and it buys back a `passthrough` on a
 * *legitimate write*. The rejected path is the common one and is flat at
 * ~103-107µs across all four builds and both modes — that flatness is the
 * control that none of this reaches the path most calls take.
 *
 * This settles the decision, not the race. Resolution is a filesystem read and
 * the write happens later in FileWriteTool with no O_NOFOLLOW, so a link
 * swapped in after this point is still a TOCTOU that has to be closed there.
 */
function allowOnlyIfResolvedFormsAgree(
  decide: (
    path: string,
    input: { [key: string]: unknown },
  ) => PermissionResult,
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  const decision = decide(absolutePath, input)
  if (decision.behavior !== 'allow') {
    return decision
  }
  const denied: PermissionResult = { behavior: 'passthrough', message: '' }
  // Every carve-out in these two functions reports `type: 'other'`, so its
  // `reason` is the carve-out's identity. Anything else is unrecognised rather
  // than matching: fail closed instead of treating two absent identities as
  // agreement, which would hand a blanket allow to a future carve-out that
  // reports a different reason shape.
  //
  // There is one dynamic `reason` in this file — `reason: safetyCheck.message`
  // on the `type: 'safetyCheck'` branch — and it is named here because it is the
  // counter-example a reader will hit when they grep to check the convention,
  // and finding it unexplained reads as the convention already being broken. It
  // is outside this population twice over: its behaviour is `'ask'`, not
  // `'allow'`, and its type is not `'other'`, so `identify` returns `undefined`
  // for it and the `=== identity` comparison it would otherwise pollute is never
  // reached. It fails closed.
  const identify = (result: PermissionResult): string | undefined =>
    result.decisionReason?.type === 'other'
      ? result.decisionReason.reason
      : undefined
  const identity = identify(decision)
  if (identity === undefined) {
    return denied
  }
  // Resolved once per decision, and lazily. This loop is not bounded at two
  // forms: `getPathsForPermissionCheck` walks the whole symlink chain and
  // returns *every* intermediate target. Its own `maxDepth` is 40, but on macOS
  // the kernel's SYMLOOP_MAX binds first — at 33 hops the walk is refused and
  // the form list collapses back to 2. So N is attacker-influenced (anything
  // that can create links under a carve-out root sets it) but hard-bounded at
  // 32, which is what makes the remaining cost tolerable rather than a hazard.
  //
  // Folding each form against a freshly resolved root set did one realpath
  // sweep of five-to-seven roots *per form*. Hoisting removes that term.
  // Measured on one harness, an allowed agent-memory path behind N links, µs
  // per check with the number of `getFoldableRootsForSession` calls beside it:
  //
  //     N            0        1        2        8       16       32
  //     per form   0/87    1/240    2/396   8/1489  16/3534  32/10146
  //     hoisted    0/88    1/242    1/332   1/1039   1/2543   1/8248
  //
  // Read the two rows honestly: the *call count* goes flat, the *time* does
  // not. A residual O(N²) remains — each of the N re-decisions walks what is
  // left of the chain again — and this hoist does not touch it, so the saving
  // is 19% at N=32 and the worst case is still ~8ms. That is the true claim;
  // "the hoist makes it flat" would be checkable and wrong.
  //
  // Two rows are controls rather than results. N=0 is the common case and must
  // stay at *zero* resolutions — hence `??=` and not an eager call, since a
  // path with no links has one form, which the `continue` below skips, so
  // nothing is folded and nothing is resolved; an eager hoist would regress it
  // to one. N=1 must be an exact no-op, one resolution either way, and 240 vs
  // 242µs is that.
  //
  // This is a per-decision snapshot, NOT a memo, and the distinction is the
  // whole reason it is safe: its lifetime is exactly this call, so it cannot
  // outlive the decision it informs. Caching resolved roots *across* calls is a
  // separate live defect that fails open, because a stale root is a
  // demonstrated way to mint an allow. Do not promote this to module scope.
  // Reusing one snapshot across the forms is also the more coherent reading —
  // every form of one path is judged against the same root set, where
  // re-resolving per form could judge two forms against two different
  // filesystems.
  let foldRoots: FoldableRoot[] | undefined
  for (const form of getPathsForPermissionCheck(absolutePath)) {
    // The written spelling is skipped outright, not merely left unfolded,
    // because a second `decide` on it cannot help. `decide(absolutePath)` above
    // produced the very decision this loop is checking the *other* forms
    // against, so re-deciding that same string would compare the decision
    // against a fresh recomputation of itself rather than against a different
    // form. Folding it first would be worse than useless: the fold could
    // rewrite it into some *other* carve-out's namespace and manufacture a
    // disagreement with the decision being checked.
    //
    // Skipping is where the cost is. A path with no symlinks in it has exactly
    // one form, so before this `continue` the common case paid for the whole
    // carve-out chain twice to learn nothing: 171.8µs → 92.1µs per allowed
    // check, and 366.0µs → 273.9µs when the config dir is behind a link and the
    // loop has real work to do as well. See the table above, which is measured
    // on the same harness — the saving is ~80µs and ~92µs, one `decide` either
    // way, and that consistency is the check that this call is what was removed
    // rather than the harness moving under two separate runs.
    //
    // Do not "simplify" this to re-deciding the written form for symmetry, and
    // do not restore the determinism argument this block used to carry. That
    // argument claimed `decide` reads only session state that nothing here
    // mutates. It also reads the filesystem: both `decideEditableInternalPath`
    // and `decideReadableInternalPath` call `resolvesToFlagConfigFile`, which
    // walks the symlink chain of every configured settings and `--mcp-config`
    // path as well as the subject — one walk per configured path, not one per
    // call site — so a concurrent re-point can change `decide`'s answer for a
    // fixed string. The skip does not rest on that guarantee and does not need
    // it — both reasons above hold whether or not `decide` is stable.
    // Re-deciding would not close anything either; it would surface the
    // pre-existing race between the walk and the decision it informs, which
    // this loop cannot close, as a spurious denial.
    if (form === absolutePath) continue
    foldRoots ??= getFoldableRootsForSession()
    const formDecision = decide(foldResolvedRootPrefix(form, foldRoots), input)
    if (
      formDecision.behavior !== 'allow' ||
      identify(formDecision) !== identity
    ) {
      return denied
    }
  }
  return decision
}

/**
 * Check if a path is an internal path that can be edited without permission.
 * Returns a PermissionResult - either 'allow' if matched, or 'passthrough' to continue checking.
 */
export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  return allowOnlyIfResolvedFormsAgree(
    decideEditableInternalPath,
    absolutePath,
    input,
  )
}

function decideEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // First, ahead of every carve-out below. A flag can aim the active settings
  // or MCP config file at any path, including inside one of these carve-outs —
  // `--settings <cwd>/.axa/agent-memory/x.json` is allowed by isAgentMemoryPath,
  // which matches that whole tree under any filename. Every carve-out here
  // grants a silent write, and none of them inspects what the file *is*, so the
  // screen has to run before all of them rather than beside any one of them.
  if (resolvesToFlagConfigFile(normalizedPath)) {
    return { behavior: 'passthrough', message: '' }
  }

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  // Template job's own directory. Env key hardcoded (vs importing JOB_ENV_KEY
  // from jobs/state) so tree-shaking eliminates the string from external
  // builds. Hijack guard: the env var value must itself resolve under the
  // config home's `jobs/` — that is `~/.axa/jobs` by default and whatever
  // CLAUDE_CONFIG_DIR points at otherwise, so do not re-spell it as a fixed
  // path. Symlink guard: every resolved form of the target (lexical + symlink
  // chain) must fall under some resolved form of the job dir, so a symlink
  // inside the job dir pointing at e.g. ~/.ssh/authorized_keys does not get a
  // free write. Resolving both sides handles the macOS /tmp → /private/tmp
  // case where the config dir lives under a symlinked root.
  //
  // Two things this comment used to claim, both checked and both false. There
  // is no `spawn.test.ts` asserting the two hardcoded spellings agree — this
  // repo has no test files at all — so the literal here and the one in
  // query/stopHooks.ts are coupled by nothing but the comments naming each
  // other. And `JOB_ENV_KEY`/`jobs/state` is not in the tree either: nothing
  // under src/ sets CLAUDE_JOB_DIR, only these two files and stopHooks read
  // it. The name is therefore externally owned in the AXA.md sense — whatever
  // spawns a job supplies it — so a branding sweep must not rename it.
  if (feature('TEMPLATES')) {
    const jobDir = process.env.CLAUDE_JOB_DIR
    if (jobDir) {
      const jobsRoot = join(getClaudeConfigHomeDir(), 'jobs')
      const jobDirForms = getPathsForPermissionCheck(jobDir).map(normalize)
      const jobsRootForms = getPathsForPermissionCheck(jobsRoot).map(normalize)
      // Hijack guard: every resolved form of the job dir must sit under some
      // resolved form of the jobs root. Resolving both sides handles the case
      // where the config home is itself a symlink (e.g. to /data/axa-config).
      //
      // Both `+ sep` tests below use the platform separator only, deliberately,
      // and are NOT a third place that needs ROOT_SEPARATOR_SPELLINGS. That set
      // exists for comparisons where one side is a lexical spelling that was
      // never normalised; here all three operands — the job-dir forms, the
      // jobs-root forms and each target form — are put through `normalize`
      // first, and `normalize` rewrites `/` to `\` under win32, so no other
      // separator spelling can reach either test.
      const isUnderJobsRoot = jobDirForms.every(jd =>
        jobsRootForms.some(jr => jd.startsWith(jr + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every(p => {
          const np = normalize(p)
          return jobDirForms.some(jd => np === jd || np.startsWith(jd + sep))
        })
        if (allInsideJobDir) {
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'other',
              reason:
                'Job directory files for current job are allowed for writing',
            },
          }
        }
      }
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  // This pre-safety-check carve-out exists because the default path is under
  // ~/.claude/, which is in DANGEROUS_DIRECTORIES. The CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // override is an arbitrary caller-designated directory with no such conflict,
  // so it gets NO special permission treatment here — writes go through normal
  // permission flow (step 5 → ask). SDK callers who want silent memory should
  // pass an allow rule for the override path.
  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  // .axa/launch.json — desktop preview config (dev server command + port).
  // The desktop's preview_start MCP tool instructs Claude to create/update
  // this file as part of the preview workflow. Without this carve-out the
  // .axa/ DANGEROUS_DIRECTORIES check prompts for it, which in SDK mode
  // cascades: user clicks "Always allow" → setMode:acceptEdits suggestion
  // applied → silent downgrade from auto mode. Matches the project-level
  // .axa/ only (not ~/.claude/) since launch.json is per-project.
  if (
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(join(getOriginalCwd(), CONFIG_DIR_NAME, 'launch.json'))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  // The config dir itself, at both scopes: ~/.axa (or CLAUDE_CONFIG_DIR) and
  // <project>/.axa. CONFIG_DIR_NAME is in DANGEROUS_DIRECTORIES, so without
  // this every edit under a config dir prompts — and there is no way for the
  // user to grant it themselves, because step 1.7 runs before allow rules, so
  // an `Edit(~/.axa/**)` rule in settings.json is unreachable.
  //
  // What this actually opens is narrow, and narrower than the motivating
  // examples: agent definitions, skills and slash commands stay on the prompting
  // side, because those files grant permission rather than merely holding text
  // (see CONFIG_DIR_PROTECTED_DIRS). What is left is AXA.md and the
  // agent-authored note directories — see CONFIG_DIR_OPEN_DIRS, which is the
  // whole of it, since classifyConfigDirRelativePath defaults to 'protected'.
  //
  // The exclusions are structural on purpose, not a matter of policy the user
  // can relax. settings.json in particular: the deny rules protecting the OAuth
  // tokens live *in* settings.json, so if an agent could rewrite it silently it
  // could delete those rules first and the whole mitigation would be circular.
  // Same reasoning for hooks/ and the other executed paths — a write there is
  // code execution on the next tool call.
  //
  // Deliberately last in this function: the earlier carve-outs must keep their
  // allow, and they return before this point, which is why the default here can
  // be restrictive without stranding them.
  //
  // Do NOT read that as "the earlier carve-outs are not classified 'open'" — an
  // earlier revision of this comment said so and it is false: `agent-memory`,
  // `agent-memory-local` and `plans` are all in CONFIG_DIR_OPEN_DIRS, and
  // relativeToConfigDirRoot resolves against the project `.axa` as well as the
  // config home. Only memdir is genuinely elsewhere (`~/.axa/projects/`, which
  // is 'secret'). The ordering is what protects them, not the classification —
  // and a guard that has to run for those paths too therefore cannot live here.
  // That is why the flag-config screen is at the top of this function.
  if (classifyConfigDirPath(normalizedPath) === 'open') {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Config directory files are allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}

/**
 * Check if a path is an internal path that can be read without permission.
 * Returns a PermissionResult - either 'allow' if matched, or 'passthrough' to continue checking.
 */
export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  return allowOnlyIfResolvedFormsAgree(
    decideReadableInternalPath,
    absolutePath,
    input,
  )
}

function decideReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // First, ahead of every carve-out below, for the same reason as the identical
  // screen at the top of checkEditableInternalPath: the carve-outs each return
  // 'allow' for a whole tree under any filename, and isAgentMemoryPath matches
  // the tree a flag can be aimed into. Reads and writes need this in the same
  // place — closing one and not the other is what happened here twice.
  if (resolvesToFlagConfigFile(normalizedPath)) {
    return { behavior: 'passthrough', message: '' }
  }

  // Session memory directory
  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  // Project directory (for reading past session memories)
  // Path format: ~/.claude/projects/{sanitized-cwd}/...
  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  // Tool results directory (persisted large outputs)
  // Use path separator suffix to prevent path traversal (e.g., tool-results-evil/)
  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSep = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (
    normalizedPath === toolResultsDir ||
    normalizedPath.startsWith(toolResultsDirWithSep)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  // Project temp directory (/tmp/claude/{sanitized-cwd}/)
  // Intentionally allows reading files from all sessions in this project, not just the current session.
  // This enables cross-session file access within the same project's temp space.
  const projectTempDir = getProjectTempDir()
  if (normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  // Tasks directory (~/.claude/tasks/) for swarm task coordination
  const tasksDir = join(getClaudeConfigHomeDir(), 'tasks') + sep
  if (
    normalizedPath === tasksDir.slice(0, -1) ||
    normalizedPath.startsWith(tasksDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  // Teams directory (~/.claude/teams/) for swarm coordination
  const teamsReadDir = join(getClaudeConfigHomeDir(), 'teams') + sep
  if (
    normalizedPath === teamsReadDir.slice(0, -1) ||
    normalizedPath.startsWith(teamsReadDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  // Bundled skill reference files extracted on first invocation.
  // SECURITY: See getBundledSkillsRoot() — the per-process nonce in the path
  // is the load-bearing defense; uid/VERSION alone are public knowledge and
  // squattable. We always write-before-read on invocation, so content under
  // this subtree is harness-controlled.
  const bundledSkillsRoot = getBundledSkillsRoot() + sep
  if (normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  // The config dir itself, at both scopes. Broader than the write carve-out by
  // one class — some paths that prompt on write are readable, because there the
  // risk is tampering rather than disclosure — but only by an explicitly listed
  // class, not by "everything that is not secret".
  //
  // That distinction is the whole point. Allowing `open || protected` here would
  // make the read path a deny-list even though the write path is an allow-list,
  // and it is the read path where the harm is irreversible: a prompt refused
  // after a write is a file you can restore, a prompt refused after a read is a
  // token the model has already seen. Anything not on CONFIG_DIR_READABLE_DIRS
  // falls through to step 12 of checkReadPermissionForTool and asks, which is
  // what main did for all of these.
  //
  // Flag-supplied config files are screened at the top of this function, so
  // both arms below are already safe for them. Do not re-add a screen here:
  // this branch is unreachable for the paths that need it most, because
  // isAgentMemoryPath above returns 'allow' for the tree a flag can be aimed
  // into. An earlier revision put the screen on this branch and left exactly
  // that hole.
  const configDirAccess = classifyConfigDirPath(normalizedPath)
  if (
    configDirAccess === 'open' ||
    (configDirAccess === 'protected' &&
      isReadableConfigDirPath(normalizedPath))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Config directory files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
