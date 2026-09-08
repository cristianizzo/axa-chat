import { useEffect } from 'react'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'

type Props = {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({ onCancel }: Props) {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return null
}

/**
 * Builds the prompt injected when the user resolves a snapshot conflict by
 * merging. `main.tsx` dynamically imports this name, so it has to exist for
 * that import to type-check — but the dialog above is a stub that calls
 * `onCancel` on mount, and `launchSnapshotUpdateDialog` wires `onCancel` to
 * `done('keep')`. The dialog therefore always resolves to `'keep'` and the
 * `choice === 'merge'` branch that calls this is unreachable today.
 *
 * It throws rather than returning a plausible string: a fake prompt would be
 * silently wrong the moment the dialog is implemented, whereas this fails
 * loudly at exactly the point where someone needs to write the real one.
 */
export function buildMergePrompt(
  _agentType: string,
  _scope: AgentMemoryScope,
): string {
  throw new Error(
    'buildMergePrompt is not implemented: SnapshotUpdateDialog is a stub that cannot yet return "merge".',
  )
}
