import * as React from 'react'
import { useEffect, useState } from 'react'
import { LegacyProjectImportDialog } from '../../components/LegacyProjectImportDialog.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  MEMORY_FILE_NAME,
} from '../../constants/product.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import {
  findLegacyProjectFiles,
  hasAnything,
  recordLegacyImportAnswer,
  type LegacyProjectFindings,
} from '../../utils/legacyProjectImport.js'
import { logError } from '../../utils/log.js'

type Stage =
  | { status: 'scanning' }
  | { status: 'offering'; projectRoot: string; findings: LegacyProjectFindings }
  | { status: 'nothingToDo'; projectRoot: string }
  | { status: 'error'; message: string }

/**
 * The on-demand half of the startup import offer.
 *
 * The offer at `interactiveHelpers.tsx` is made once and then suppressed by a
 * flag, and declining is deliberately sticky — so without this command a
 * decline, or an import that copied only part of what it should, would be
 * unreachable for the rest of the project's life. `/import-conversations` is
 * not that escape hatch: it reads `~/.claude` and carries across conversations,
 * global settings and credentials, and never looks at a project's own
 * `CLAUDE.md` or `.claude/`.
 *
 * Ignores both flags on purpose. Someone typing this has asked for the offer.
 */
function ImportProjectScreen({
  onDone,
}: {
  onDone: () => void
}): React.ReactNode {
  const [stage, setStage] = useState<Stage>({ status: 'scanning' })

  // Local-jsx commands are modal — the REPL disables its ambient handlers while
  // one is mounted — and three of the four stages render no Select at all, two
  // of them telling the user to press esc. So this is the only way out of them.
  //
  // Off during `offering`, where the dialog owns every exit: it records the
  // outcome on its Selects' onCancel, including on the result screen, where esc
  // has to persist 'imported'. `useKeybinding` calls stopImmediatePropagation()
  // on a match, so leaving this on there could swallow that and skip the write
  // — reinstating the nag this command exists to end.
  useKeybinding('confirm:no', onDone, {
    context: 'Confirmation',
    isActive: stage.status !== 'offering',
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The same root the startup offer scans, so the two cannot disagree
        // about which directory this project is.
        const projectRoot = findCanonicalGitRoot(getOriginalCwd()) ?? getOriginalCwd()
        const findings = await findLegacyProjectFiles(projectRoot)
        if (cancelled) return
        setStage(
          hasAnything(findings)
            ? { status: 'offering', projectRoot, findings }
            : { status: 'nothingToDo', projectRoot },
        )
      } catch (error) {
        logError(error)
        if (!cancelled) setStage({ status: 'error', message: String(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  switch (stage.status) {
    case 'scanning':
      return (
        <Pane>
          <Text dimColor>Looking for Claude Code files in this project…</Text>
        </Pane>
      )

    case 'error':
      return (
        <Pane>
          <Text color="error">{stage.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>(press esc to close)</Text>
          </Box>
        </Pane>
      )

    case 'nothingToDo':
      return (
        <Pane>
          <Text>Nothing to import.</Text>
          <Text dimColor>
            {stage.projectRoot} has no Claude Code memory files, and nothing
            readable in {LEGACY_CONFIG_DIR_NAME}/ that {MEMORY_FILE_NAME} and{' '}
            {CONFIG_DIR_NAME}/ do not already have.
          </Text>
          <Box marginTop={1}>
            <Text dimColor>(press esc to close)</Text>
          </Box>
        </Pane>
      )

    case 'offering':
      return (
        <LegacyProjectImportDialog
          projectRoot={stage.projectRoot}
          findings={stage.findings}
          // Recorded exactly as the startup offer would: the dialog's two
          // decline options say "don't ask again", and an option that silently
          // did nothing when reached this way would be a lie.
          onDone={outcome => {
            recordLegacyImportAnswer(outcome)
            if (outcome === 'imported') {
              // The startup offer runs before the memory files are first read,
              // so it needs no invalidation. This runs long after, and
              // getMemoryFiles is memoized — without this the screen says
              // "AXA.md created" while the instructions it names stay out of
              // context for the rest of the session.
              clearMemoryFileCaches()
            }
            onDone()
          }}
        />
      )
  }
}

export const call: LocalJSXCommandCall = async onDone => {
  return <ImportProjectScreen onDone={onDone} />
}
