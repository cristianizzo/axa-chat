import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import {
  acquireUpdateLock,
  applyStagedBinary,
  currentRevision,
  findBun,
  findRepoDir,
  gitLine,
  recordBuiltSha,
  runStagedUpdate,
} from '../../utils/sourceUpdate.js'

export const call: LocalCommandCall = async () => {
  const repoDir = findRepoDir()
  if (!repoDir) {
    return {
      type: 'text',
      value:
        'Could not find the axa-chat source tree to update. The running binary should sit at the source root, beside package.json, scripts/build.ts and src/entrypoints/cli.tsx. If you installed elsewhere, run `bun run update` in that directory.',
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
  const release = await acquireUpdateLock(repoDir)
  if (!release) {
    return {
      type: 'text',
      value:
        'An update is already running in this source tree (started in the background, or by another axa session). Wait for it to finish and try again.',
    }
  }

  try {
    const before = await currentRevision(repoDir)

    // `update:staged`, not `update`: the plain script builds to ./cli-dev,
    // which for a compiled install is the binary running this very command.
    // `bun build --outfile` truncates its target in place, so that either fails
    // outright or takes the session down. Staging beside it and renaming is
    // both safe and what the background updater already does.
    try {
      await runStagedUpdate(repoDir, bun)
    } catch (e) {
      return {
        type: 'text',
        value: `Update failed:\n${(e as Error).message.slice(-1500)}`,
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
    let trimmed = false
    if (isInBundledMode()) {
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
    await release().catch(() => {})
  }
}
