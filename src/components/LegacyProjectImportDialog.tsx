import * as React from 'react'
import { useState } from 'react'
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  LEGACY_LOCAL_MEMORY_FILE_NAME,
  LEGACY_MEMORY_FILE_NAME,
  LOCAL_MEMORY_FILE_NAME,
  MEMORY_FILE_NAME,
  PRODUCT_NAME,
} from '../constants/product.js'
import { Box, Text } from '../ink.js'
import {
  importLegacyProject,
  type LegacyProjectFindings,
  type LegacyProjectImportOutcome,
} from '../utils/legacyProjectImport.js'
import { logError } from '../utils/log.js'
import { Select } from './CustomSelect/select.js'
import { Pane } from './design-system/Pane.js'

export type { LegacyProjectImportOutcome }

type Props = {
  projectRoot: string
  findings: LegacyProjectFindings
  onDone: (outcome: LegacyProjectImportOutcome) => void
}

/** One line per thing the import would copy, so the user confirms specifics. */
function summarise(findings: LegacyProjectFindings): string[] {
  const lines: string[] = []
  if (findings.memoryFile) {
    lines.push(`${LEGACY_MEMORY_FILE_NAME} → ${MEMORY_FILE_NAME}`)
  }
  if (findings.localMemoryFile) {
    lines.push(`${LEGACY_LOCAL_MEMORY_FILE_NAME} → ${LOCAL_MEMORY_FILE_NAME}`)
  }
  if (findings.configDir) {
    lines.push(`${LEGACY_CONFIG_DIR_NAME}/ → ${CONFIG_DIR_NAME}/`)
  }
  return lines
}

export function LegacyProjectImportDialog({
  projectRoot,
  findings,
  onDone,
}: Props): React.ReactNode {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string[] | null>(null)
  // What to report once the dialog closes. 'skipped' until an import is run,
  // so dismissing the offer any other way — Esc, or the Select's own cancel —
  // still counts as an answer.
  const [outcome, setOutcome] = useState<LegacyProjectImportOutcome>('skipped')

  if (result) {
    const failed = result.some(
      line => line.startsWith('could not copy') || line.startsWith('Import failed'),
    )
    return (
      <Pane>
        <Box marginBottom={1}>
          <Text bold>
            {failed ? 'Import finished with errors' : `Imported into ${PRODUCT_NAME}`}
          </Text>
        </Box>
        {result.map(line => (
          <Text key={line}>{line}</Text>
        ))}
        <Box marginTop={1}>
          <Text dimColor>(press enter to continue)</Text>
        </Box>
        <Select
          options={[{ label: 'Continue', value: 'continue' }]}
          onChange={() => onDone(outcome)}
          onCancel={() => onDone(outcome)}
        />
      </Pane>
    )
  }

  if (busy) {
    return (
      <Pane>
        <Text dimColor>Copying…</Text>
      </Pane>
    )
  }

  return (
    <Pane>
      <Box marginBottom={1}>
        <Text bold>This project is set up for Claude Code</Text>
      </Box>
      <Text dimColor>
        {PRODUCT_NAME} reads its own files, so these are currently invisible to
        it. Copy them across?
      </Text>
      <Box marginTop={1} flexDirection="column">
        {summarise(findings).map(line => (
          <Text key={line}>• {line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Copied, never moved: the originals stay exactly as they are, so this
          repo keeps working with Claude Code. Files {CONFIG_DIR_NAME}/ already
          has are left alone.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={[
            { label: 'Import', value: 'import' },
            { label: "No, don't ask again for this project", value: 'skip' },
            {
              label: "No, and don't ask again in any project",
              value: 'skip-everywhere',
            },
          ]}
          onChange={value => {
            if (value === 'skip-everywhere') {
              onDone('skipped-everywhere')
              return
            }
            if (value !== 'import') {
              onDone('skipped')
              return
            }
            setBusy(true)
            void (async () => {
              try {
                const result = await importLegacyProject(projectRoot, findings)
                const lines: string[] = []
                if (result.copiedMemoryFile) {
                  lines.push(`${MEMORY_FILE_NAME} created`)
                }
                if (result.copiedLocalMemoryFile) {
                  lines.push(`${LOCAL_MEMORY_FILE_NAME} created`)
                }
                if (result.copiedFromConfigDir.length > 0) {
                  lines.push(
                    `${CONFIG_DIR_NAME}/: ${result.copiedFromConfigDir.join(', ')}`,
                  )
                }
                for (const failure of result.failures) {
                  lines.push(`could not copy ${failure.path}: ${failure.error}`)
                }
                if (lines.length === 0) {
                  lines.push('Everything was already present. Nothing to do.')
                }
                // Counted as answered even when some entries failed. Treating a
                // per-entry failure as a retry meant the answered-flag was never
                // written, so the dialog returned on every launch while this
                // screen listed what had been copied and read as success.
                //
                // The failures are still listed below, and `/import-project`
                // re-runs this on demand — which matters more than it sounds,
                // because `cp` abandons a top-level entry at the first error
                // and leaves the rest of that subtree uncopied. Re-running
                // picks up exactly what is still missing.
                setOutcome('imported')
                setResult(lines)
              } catch (error) {
                logError(error)
                setOutcome('failed')
                setResult([`Import failed: ${String(error)}`])
              }
            })()
          }}
          onCancel={() => onDone('skipped')}
        />
      </Box>
    </Pane>
  )
}
