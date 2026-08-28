import { join } from 'path'
import { useEffect } from 'react'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

type Props = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export async function computeDefaultInstallDir(): Promise<string> {
  return join(getClaudeConfigHomeDir(), 'assistant')
}

export function NewInstallWizard({ onCancel }: Props) {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return null
}
