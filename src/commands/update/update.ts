import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import {
  currentBinaryInstall,
  describeOutcome,
  runBinaryUpdate,
} from '../../utils/binaryUpdate.js'
import { isCompiledBinary } from '../../utils/bundledMode.js'
import {
  acquireUpdateLock,
  applyStagedBinary,
  clearUpdateProgress,
  currentRevision,
  findBun,
  findRepoDir,
  gitLine,
  recordBuiltSha,
  runStagedUpdate,
  type UpdateLock,
} from '../../utils/sourceUpdate.js'

export const call: LocalCommandCall = async () => {
  // Two update paths, and which one applies is decided by where the running
  // executable actually sits, not by a flag or a marker file.
  //
  // A released install is a bare versioned file under `versions/` with a
  // symlink pointing at it: there is no source tree, no bun and no compiler on
  // that machine, so the only thing to do is download the next version and flip
  // the symlink. A developer's checkout has all three and no release to
  // download, so it pulls and rebuilds. Running this one first because it is
  // the one with a positive, unambiguous test — `currentBinaryInstall()`
  // returns null for everything that is not exactly this layout.
  const binaryInstall = currentBinaryInstall()
  if (binaryInstall) {
    const outcome = await runBinaryUpdate()
    return { type: 'text', value: describeOutcome(outcome, binaryInstall) }
  }

  const repoDir = findRepoDir()
  if (!repoDir) {
    return {
      type: 'text',
      value:
        'Could not find anything to update. A released install is a versioned binary under ~/.local/share/axa/versions with ~/.local/bin/axa pointing at it — reinstall with the one-liner in the README if that is what you expected. Running from a source tree, the binary should sit at the source root beside package.json, scripts/build.ts and src/entrypoints/cli.tsx; if you built it elsewhere, run `bun run update` in that directory.',
    }
  }

  let bun: string
  try {
    bun = await findBun()
  } catch (e) {
    return { type: 'text', value: (e as Error).message }
  }

  // The same lock the background updater takes: both run `bun install` and a
  // compile in this tree, and interleaving those corrupts node_modules.
  let lock: UpdateLock | null
  try {
    lock = await acquireUpdateLock(repoDir)
  } catch (e) {
    return {
      type: 'text',
      value: `Could not take the update lock in ${repoDir}:\n${(e as Error).message}`,
    }
  }
  if (!lock) {
    return {
      type: 'text',
      value:
        'An update is already running in this source tree (started in the background, or by another axa session). Wait for it to finish and try again.',
    }
  }

  try {
    const before = await currentRevision(repoDir)

    // `update:staged`, not `update`. Both stage their build and rename it into
    // place — `bun build --outfile` truncates its target, which for a compiled
    // install is the binary running this very command — but `update` renames
    // onto the live binary immediately, and the swap has to happen under this
    // command's own control so it can report what it did.
    try {
      await runStagedUpdate(repoDir, bun, { lost: lock.lost })
    } catch (e) {
      return {
        type: 'text',
        value: `Update failed:\n${(e as Error).message.slice(-1500)}`,
      }
    }

    // The build can outlast the lock: a suspend past the stale window has
    // another session reap and retake it, and the swap and the state write
    // below would then race whatever that session is doing.
    if (lock.lost.aborted) {
      return {
        type: 'text',
        value:
          'The update built, but this session lost the update lock while it ran (the machine was likely asleep) and another session has taken it. Nothing was replaced. Try again once that one has finished.',
      }
    }

    if (!applyStagedBinary(repoDir)) {
      return {
        type: 'text',
        value:
          'Update ran but produced no new binary, so nothing was replaced. The source tree may have been updated; run `bun run update:staged` in it to see why the build produced no output.',
      }
    }

    // Tell the background updater the live binary is current, so it does not
    // stage a second build of the very commit that was just built here.
    await recordBuiltSha(repoDir)

    // Trim build-time deps: the compiled binary is standalone, so node_modules
    // (~400MB) isn't needed at runtime. Only do this for the compiled binary —
    // in source mode (`bun run dev`) node_modules is required by the running
    // process. Best-effort; a future update reinstalls it via `bun install`.
    //
    // This was dead code until `isCompiledBinary()` existed: the predicate was
    // `isInBundledMode()`, which is false in every binary this repo builds, so
    // the trim never ran anywhere and the `trimNote` below was never printed.
    let trimmed = false
    if (isCompiledBinary()) {
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
  } finally {
    // `runStagedUpdate` drives the same progress store the background updater
    // renders above the prompt. Here the result is reported in the command's
    // own output instead, so leaving the bar behind would strand it at whatever
    // percentage the child last emitted for the rest of the session.
    clearUpdateProgress()
    await lock.release().catch(() => {})
  }
}
