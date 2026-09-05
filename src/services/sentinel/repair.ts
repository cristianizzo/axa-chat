/**
 * Attempt to fix a newly introduced failure without touching the user's tree.
 *
 * The isolation is the whole point. An agent that edits your working copy
 * while you are reading the failure report is worse than no agent at all: you
 * cannot tell your edits from its edits, and a wrong fix has to be untangled
 * by hand. So the repair happens in a throwaway git worktree, and the only
 * thing that ever reaches the user is a patch to look at.
 *
 * Shape of a run:
 *   1. Create a worktree at the current HEAD.
 *   2. Copy the dirty working-tree files into it and commit them there, so the
 *      worktree reproduces the broken state and `git diff` afterwards shows
 *      only what the agent did.
 *   3. Run a tool-restricted agent with cwd pointed at the worktree.
 *   4. Re-run verify inside the worktree. A fix that does not verify is not a
 *      fix, and is discarded rather than shown.
 *   5. Emit the diff. Remove the worktree.
 *
 * Nothing here writes to the main repository, and in particular nothing stages
 * anything: the user's index is read but never modified.
 */

import { randomBytes } from 'crypto'
import type { Stats } from 'fs'
import { cp, lstat, mkdir, realpath, rm } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  createAgentWorktree,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import type { SentinelConfig } from './config.js'
import { runVerify } from './verify.js'

/** Enough turns to read the failing file, edit, and re-check; not enough to wander. */
const MAX_REPAIR_TURNS = 24
/** A patch longer than this is not a targeted fix and is not worth reading inline. */
const MAX_DIFF_CHARS = 12_000
const GIT_TIMEOUT_MS = 30_000

export type RepairOutcome =
  /** Verify passes in the worktree and the agent changed something. */
  | { status: 'fixed'; diff: string }
  /** The agent ran but the failure survived, or it changed nothing. */
  | { status: 'no_fix' }
  /** Never got as far as trying — no worktree, copy failed, aborted. */
  | { status: 'unavailable'; reason: string }

export async function attemptRepair({
  config,
  gitRoot,
  dirtyPaths,
  introduced,
  context,
  abortController,
}: {
  config: SentinelConfig
  gitRoot: string
  /**
   * Individual file paths relative to `gitRoot` — everything differing from
   * HEAD plus everything untracked, as `getTreeChanges` reports it. A staged
   * rename appears as both paths, the old one absent from disk, which is what
   * makes it mirror as a deletion rather than leaving a stale duplicate.
   */
  dirtyPaths: string[]
  /** The failures to fix — already filtered down to the new ones. */
  introduced: string[]
  context: REPLHookContext
  /** Owned by the caller, which bounds how long a repair may run. */
  abortController: AbortController
}): Promise<RepairOutcome> {
  // A fresh slug every run. Reusing one would hand the agent whatever the
  // previous repair left behind, and `createAgentWorktree` resumes on collision
  // rather than starting clean.
  const slug = `sentinel-${randomBytes(4).toString('hex')}`

  let worktree: Awaited<ReturnType<typeof createAgentWorktree>>
  try {
    worktree = await createAgentWorktree(slug)
  } catch (e: unknown) {
    return { status: 'unavailable', reason: (e as Error).message }
  }

  const { worktreePath, worktreeBranch, gitRoot: mainRoot, hookBased } = worktree

  try {
    // Everything below — the snapshot commit, the diff, the reset — is plain
    // git. A hook-provided worktree may be any VCS at all, so there is no way
    // to isolate the agent's changes and nothing safe to show.
    if (hookBased) {
      return { status: 'unavailable', reason: 'hook-based worktree' }
    }

    if (!(await alignToHead(gitRoot, worktreePath))) {
      return { status: 'unavailable', reason: 'could not align worktree to HEAD' }
    }
    await mirrorDirtyFiles(gitRoot, worktreePath, dirtyPaths)
    // Commit the broken state so the later `git diff HEAD` isolates the agent's
    // work. This commit lives on the worktree's own throwaway branch and is
    // deleted with it.
    const staged = await commitAll(worktreePath, 'sentinel: broken state')
    if (!staged) {
      return { status: 'unavailable', reason: 'could not snapshot the tree' }
    }

    await runWithCwdOverride(worktreePath, () =>
      runForkedAgent({
        promptMessages: [
          createUserMessage({
            content: buildRepairPrompt(config.verify, introduced),
          }),
        ],
        cacheSafeParams: createCacheSafeParams(context),
        canUseTool: createRepairCanUseTool(worktreePath, config.verify),
        querySource: 'sentinel_repair',
        forkLabel: 'sentinel_repair',
        skipTranscript: true,
        skipCacheWrite: true,
        maxTurns: MAX_REPAIR_TURNS,
        overrides: { abortController },
      }),
    )

    if (abortController.signal.aborted) {
      return { status: 'unavailable', reason: 'aborted' }
    }

    const diff = await diffAgainstHead(worktreePath)
    if (!diff) return { status: 'no_fix' }

    // Trust the command, not the agent's account of it. An agent that reports
    // success having deleted the failing test would pass its own review.
    const after = await runVerify(
      config.verify,
      worktreePath,
      abortController.signal,
    )
    if (!after.ok) {
      logForDebugging('[sentinel] repair did not verify — discarding')
      return { status: 'no_fix' }
    }

    return { status: 'fixed', diff: truncate(diff) }
  } catch (e: unknown) {
    return { status: 'unavailable', reason: (e as Error).message }
  } finally {
    await removeAgentWorktree(worktreePath, worktreeBranch, mainRoot, hookBased)
  }
}

/**
 * Move the worktree onto the commit the user is actually sitting on.
 *
 * `createAgentWorktree` branches from `origin/<default>`, which is right for
 * the agent worktrees it was written for and wrong here. On a feature branch
 * that is twenty commits ahead, laying the dirty files over origin/main would
 * produce a tree that is broken in ways that have nothing to do with the
 * failure being repaired, and the agent would chase them instead.
 *
 * The reset is hard, on a throwaway branch, in a directory created moments ago
 * and deleted in the caller's `finally`. There is nothing in it to lose.
 */
async function alignToHead(
  gitRoot: string,
  worktreePath: string,
): Promise<boolean> {
  const head = await execFileNoThrowWithCwd('git', ['rev-parse', 'HEAD'], {
    cwd: gitRoot,
    timeout: GIT_TIMEOUT_MS,
  })
  if (head.code !== 0) return false

  // Linked worktrees share the main repository's object store, so the SHA is
  // already present and this needs no fetch.
  const reset = await execFileNoThrowWithCwd(
    'git',
    ['reset', '--hard', head.stdout.trim()],
    { cwd: worktreePath, timeout: GIT_TIMEOUT_MS },
  )
  return reset.code === 0
}

/**
 * Reproduce the user's uncommitted work inside the worktree.
 *
 * The worktree is a clean checkout of HEAD, so it does not contain the very
 * edits that caused the failure. Copying is used rather than `git stash` or
 * `git diff | git apply`: a stash mutates the user's repository, and a patch
 * cannot carry untracked files, which are the common case for a new module.
 */
async function mirrorDirtyFiles(
  gitRoot: string,
  worktreePath: string,
  dirtyPaths: string[],
): Promise<void> {
  for (const path of dirtyPaths) {
    // Defence in depth: these paths come from git, but a `..` traversal here
    // would write outside the worktree, which is the one thing this must not do.
    const from = resolve(gitRoot, path)
    const to = resolve(worktreePath, path)
    if (!isInside(gitRoot, from) || !isInside(worktreePath, to)) continue

    // The worktree lives under `<gitRoot>/<config>/worktrees/` (worktreePathFor
    // joins CONFIG_DIR_NAME), so in a project that does not gitignore that
    // directory its own files come back as untracked changes. Copying those
    // would be copying a directory into itself.
    if (isInside(worktreePath, from)) continue

    const info = await lstatOrNull(from)

    // Missing in the main tree means the user deleted it, and the worktree
    // still has HEAD's copy — so mirroring a deletion means removing it.
    if (!info) {
      await rm(to, { recursive: true, force: true })
      continue
    }

    // Symlinks are not mirrored at all. Copying one verbatim preserves a
    // target that may lead straight out of the worktree, and the path checks
    // guarding Edit/Write compare the path the agent asked for, not where the
    // link goes — so a `../../..` target would pass every one of them. The
    // worktree simply goes without: it then reflects the tree slightly
    // inaccurately, which at worst costs a repair that fails to verify and is
    // discarded, and never costs a write to the user's checkout.
    if (info.isSymbolicLink()) {
      logForDebugging(`[sentinel] not mirroring symlink ${path}`)
      continue
    }

    // git names files individually with one exception: a submodule, or any
    // nested repository it cannot look inside, comes back as `dir/`. Copying
    // one in would mean pulling a whole separate repository into the worktree,
    // and `cp` without `recursive` throws — which would fail the entire repair
    // over a directory it was never going to fix anything in.
    if (info.isDirectory()) {
      logForDebugging(`[sentinel] not mirroring nested repository ${path}`)
      continue
    }

    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { force: true })
  }
}

/** lstat, not stat: a broken or escaping symlink must be seen as a symlink. */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Like `isInside`, but answers where the path actually lands rather than what
 * it spells.
 *
 * A string comparison is not enough for a write target. The worktree is a
 * checkout of HEAD, so any symlink committed to the repository is present in
 * it — and `<worktree>/docs/link/x` is textually inside the worktree while
 * resolving wherever `docs/link` points, which for a committed `../../..` is
 * the user's checkout or beyond.
 *
 * The target usually does not exist yet, since the common case is creating a
 * file, and `realpath` on a missing path just throws. So this walks up to the
 * deepest ancestor that does exist, resolves that, and re-attaches the rest:
 * the segments that do not exist cannot be symlinks.
 */
async function resolvesInside(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => root)
  const trailing: string[] = []
  let existing = target
  for (;;) {
    const real = await realpath(existing).catch(() => null)
    if (real !== null) return isInside(realRoot, resolve(real, ...trailing))
    const parent = dirname(existing)
    // Reached the filesystem root without finding anything that exists, which
    // means the path is not under the worktree by any reading.
    if (parent === existing) return false
    trailing.unshift(basename(existing))
    existing = parent
  }
}

async function commitAll(cwd: string, message: string): Promise<boolean> {
  const add = await execFileNoThrowWithCwd('git', ['add', '-A'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  })
  if (add.code !== 0) return false
  // Identity is supplied inline rather than read from config. This commit is
  // scaffolding — it exists so the later diff has something to be relative to,
  // and it is deleted with the worktree — so it must not depend on the user
  // having a global `user.email`, and it must not attribute itself to them.
  const commit = await execFileNoThrowWithCwd(
    'git',
    [
      '-c',
      'user.name=sentinel',
      '-c',
      'user.email=sentinel@localhost',
      'commit',
      '--no-verify',
      '--allow-empty',
      '-m',
      message,
    ],
    { cwd, timeout: GIT_TIMEOUT_MS },
  )
  return commit.code === 0
}

/** The agent's changes only — the broken state is already committed. */
async function diffAgainstHead(cwd: string): Promise<string | null> {
  const add = await execFileNoThrowWithCwd('git', ['add', '-A'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  })
  if (add.code !== 0) return null
  const diff = await execFileNoThrowWithCwd(
    'git',
    ['diff', '--cached', 'HEAD'],
    { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10_000_000 },
  )
  if (diff.code !== 0) return null
  const text = diff.stdout.trim()
  return text.length > 0 ? text : null
}

function truncate(diff: string): string {
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (patch truncated)`
    : diff
}

/**
 * Read anything, write only inside the worktree, and run only the verify
 * command.
 *
 * Absolute paths are the reason the write check exists at all: cwd is
 * overridden to the worktree so relative paths land there naturally, but an
 * absolute `file_path` would reach straight back into the user's checkout and
 * defeat the isolation this whole module is built around.
 */
function createRepairCanUseTool(
  worktreePath: string,
  verifyCommand: string,
): CanUseToolFn {
  return async (tool: Tool, input: Record<string, unknown>) => {
    const allow = { behavior: 'allow' as const, updatedInput: input }

    if (
      tool.name === FILE_READ_TOOL_NAME ||
      tool.name === GREP_TOOL_NAME ||
      tool.name === GLOB_TOOL_NAME
    ) {
      return allow
    }

    if (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) {
      const filePath = input.file_path
      if (typeof filePath !== 'string') {
        return deny(tool, 'file_path is required')
      }
      const target = isAbsolute(filePath)
        ? filePath
        : join(worktreePath, filePath)
      if (!(await resolvesInside(worktreePath, target))) {
        return deny(
          tool,
          'This agent may only edit files inside its isolated worktree',
        )
      }
      return allow
    }

    // Iterating against real output is what makes the fix worth showing, but
    // a general shell would let the agent reach outside the worktree, so the
    // verify command is the only one on offer.
    if (tool.name === BASH_TOOL_NAME) {
      if (typeof input.command === 'string' && input.command.trim() === verifyCommand) {
        return allow
      }
      return deny(tool, `Only \`${verifyCommand}\` may be run in this context`)
    }

    return deny(tool, 'Tool not available during an automated repair')
  }
}

function deny(tool: Tool, reason: string) {
  logForDebugging(`[sentinel] denied ${tool.name}: ${reason}`)
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: { type: 'other' as const, reason },
  }
}

function buildRepairPrompt(verifyCommand: string, introduced: string[]): string {
  return `Recent edits in this repository introduced the following failures, reported by \`${verifyCommand}\`:

${introduced.map(f => `- ${f}`).join('\n')}

You are working in an isolated throwaway copy of the repository. Nothing you do here reaches the user's working tree — your output is a patch they will review.

Fix these specific failures and nothing else:
- Do not reformat, refactor, or clean up code that is unrelated to the failures above.
- Do not delete, skip, or weaken tests or assertions to make the command pass.
- Do not change the verify command or its configuration.
- If a failure needs a decision you cannot make from the code alone, leave it and fix the rest.

Run \`${verifyCommand}\` to confirm your work. It is the only shell command available to you. When it passes, stop.`
}
