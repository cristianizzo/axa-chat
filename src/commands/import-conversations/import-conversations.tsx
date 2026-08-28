import * as React from 'react'
import { useEffect, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Pane } from '../../components/design-system/Pane.js'
import { PRODUCT_NAME } from '../../constants/product.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  isEmptyPlan,
  planClaudeCodeImport,
  runClaudeCodeImport,
  type ImportPlan,
  type ImportResult,
} from '../../services/import/claudeCodeImport.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { logError } from '../../utils/log.js'

type Props = {
  onDone: () => void
}

type Stage =
  | { status: 'choosingSource' }
  | { status: 'planning' }
  | { status: 'confirming'; plan: ImportPlan }
  | { status: 'importing'; plan: ImportPlan; done: number; total: number }
  | { status: 'done'; result: ImportResult }
  | { status: 'error'; message: string }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One line per thing the import would do, so the user confirms specifics. */
function planSummary(plan: ImportPlan): string[] {
  const lines: string[] = []
  const repairs = plan.files.filter(file => file.timestampOnly).length
  const copies = plan.files.length - repairs
  if (copies > 0) {
    lines.push(
      `${copies} conversation file${copies === 1 ? '' : 's'} across ${plan.projects} project${plan.projects === 1 ? '' : 's'} (${formatBytes(plan.bytes)})`,
    )
  }
  if (repairs > 0) {
    lines.push(
      `${repairs} already-imported file${repairs === 1 ? '' : 's'} to restore the original date on`,
    )
  }
  if (plan.settings) lines.push('settings.json')
  if (plan.configKeys.length > 0) {
    lines.push(`${plan.configKeys.length} config values (${plan.configKeys.join(', ')})`)
  }
  if (plan.credentials) lines.push('login credentials — you stay signed in')
  return lines
}

function ImportConversations({ onDone }: Props): React.ReactNode {
  const [stage, setStage] = useState<Stage>({ status: 'choosingSource' })

  useKeybinding('confirm:no', onDone, { context: 'Confirmation' })

  const startPlanning = () => {
    setStage({ status: 'planning' })
    void (async () => {
      try {
        const plan = await planClaudeCodeImport()
        if (!plan.available) {
          setStage({
            status: 'error',
            message:
              plan.unavailableReason ?? 'Nothing available to import from.',
          })
          return
        }
        setStage({ status: 'confirming', plan })
      } catch (error) {
        logError(error)
        setStage({ status: 'error', message: String(error) })
      }
    })()
  }

  const startImport = (plan: ImportPlan) => {
    setStage({
      status: 'importing',
      plan,
      done: 0,
      total: plan.files.length,
    })
    void (async () => {
      try {
        const result = await runClaudeCodeImport(plan, (done, total) => {
          setStage({ status: 'importing', plan, done, total })
        })
        setStage({ status: 'done', result })
      } catch (error) {
        logError(error)
        setStage({ status: 'error', message: String(error) })
      }
    })()
  }

  switch (stage.status) {
    case 'choosingSource':
      return (
        <Pane>
          <Box marginBottom={1}>
            <Text bold>Import into {PRODUCT_NAME}</Text>
          </Box>
          <Text dimColor>
            Copies conversations, settings and login across. The source install
            is never modified, and you can re-run this later to pick up
            anything new.
          </Text>
          <Box marginTop={1}>
            <Select
              options={[{ label: 'Claude Code', value: 'claude-code' }]}
              onChange={startPlanning}
              onCancel={onDone}
            />
          </Box>
        </Pane>
      )

    case 'planning':
      return (
        <Pane>
          <Text dimColor>Checking what there is to import…</Text>
        </Pane>
      )

    case 'confirming': {
      if (isEmptyPlan(stage.plan)) {
        return (
          <Pane>
            <Text>Everything has already been imported. Nothing to do.</Text>
            <Box marginTop={1}>
              <Text dimColor>(press esc to close)</Text>
            </Box>
          </Pane>
        )
      }
      const plan = stage.plan
      return (
        <Pane>
          <Box marginBottom={1}>
            <Text bold>Import from Claude Code</Text>
          </Box>
          <Text dimColor>
            {plan.sourceDir} → {plan.destinationDir}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {planSummary(plan).map(line => (
              <Text key={line}>• {line}</Text>
            ))}
          </Box>
          {plan.conflicts.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text color="warning">
                {plan.conflicts.length} conversation
                {plan.conflicts.length === 1 ? '' : 's'} changed in both places
                since the last import and will be left as {PRODUCT_NAME} has
                {plan.conflicts.length === 1 ? ' it' : ' them'}:
              </Text>
              {plan.conflicts.slice(0, 3).map(conflict => (
                <Text key={conflict.path} dimColor>
                  {conflict.path}
                </Text>
              ))}
              {plan.conflicts.length > 3 ? (
                <Text dimColor>…and {plan.conflicts.length - 3} more</Text>
              ) : null}
            </Box>
          ) : null}
          {plan.unreadable.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text color="warning">
                {plan.unreadable.length} item
                {plan.unreadable.length === 1 ? '' : 's'} could not be read and
                are not included above:
              </Text>
              {plan.unreadable.slice(0, 3).map(problem => (
                <Text key={problem.path} dimColor>
                  {problem.path}: {problem.error}
                </Text>
              ))}
              {plan.unreadable.length > 3 ? (
                <Text dimColor>…and {plan.unreadable.length - 3} more</Text>
              ) : null}
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>
              Nothing is removed from {plan.sourceDir}, and existing{' '}
              {PRODUCT_NAME} settings are kept as they are.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Select
              options={[
                { label: 'Import', value: 'import' },
                { label: 'Cancel', value: 'cancel' },
              ]}
              onChange={value =>
                value === 'import' ? startImport(plan) : onDone()
              }
              onCancel={onDone}
            />
          </Box>
        </Pane>
      )
    }

    case 'importing':
      return (
        <Pane>
          <Text>
            Importing… {stage.done}/{stage.total} files
          </Text>
        </Pane>
      )

    case 'done': {
      const { result } = stage
      return (
        <Pane>
          <Box marginBottom={1}>
            <Text bold>Import complete</Text>
          </Box>
          {result.filesCopied > 0 ? (
            <Text>
              {result.filesCopied} file
              {result.filesCopied === 1 ? '' : 's'} copied (
              {formatBytes(result.bytesCopied)})
            </Text>
          ) : null}
          {result.filesRepaired > 0 ? (
            <Text>
              {result.filesRepaired === 1
                ? '1 file restored to its original date'
                : `${result.filesRepaired} files restored to their original dates`}
            </Text>
          ) : null}
          {result.filesCopied === 0 && result.filesRepaired === 0 ? (
            <Text>No conversation files needed copying.</Text>
          ) : null}
          {result.conflicts.length > 0 ? (
            <Text color="warning">
              {result.conflicts.length} conversation
              {result.conflicts.length === 1 ? '' : 's'} left untouched — changed
              in both places since the last import
            </Text>
          ) : null}
          {result.settingsImported ? <Text>settings.json imported</Text> : null}
          {result.configKeysImported.length > 0 ? (
            <Text>
              {result.configKeysImported.length} config values imported
            </Text>
          ) : null}
          {result.credentialsImported ? (
            <Text>Credentials imported — you are signed in</Text>
          ) : null}
          {result.failures.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text color="warning">
                {result.failures.length} item
                {result.failures.length === 1 ? '' : 's'} could not be imported:
              </Text>
              {result.failures.slice(0, 5).map(failure => (
                <Text key={failure.path} dimColor>
                  {failure.path}: {failure.error}
                </Text>
              ))}
              {result.failures.length > 5 ? (
                <Text dimColor>…and {result.failures.length - 5} more</Text>
              ) : null}
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text dimColor>
              Restart {PRODUCT_NAME} to pick up the imported settings. (press
              esc to close)
            </Text>
          </Box>
        </Pane>
      )
    }

    case 'error':
      return (
        <Pane>
          <Text color="error">{stage.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>(press esc to close)</Text>
          </Box>
        </Pane>
      )
  }
}

export const call: LocalJSXCommandCall = async onDone => {
  return <ImportConversations onDone={onDone} />
}
