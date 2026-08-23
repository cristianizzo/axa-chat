import type { ReactNode } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import type { UpdateProgress, UpdateStage } from '../../utils/sourceUpdate.js'
import {
  getUpdateProgress,
  overallPercent,
  subscribeUpdateProgress,
} from '../../utils/sourceUpdate.js'

const BAR_WIDTH = 20
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']

const STAGE_LABEL: Record<UpdateStage, string> = {
  download: 'Downloading update',
  install: 'Installing dependencies',
  build: 'Building',
}

/**
 * The bar itself. Split out so the spinner's interval only exists while an
 * update is running — hooks cannot live behind the early return in the parent.
 */
function ProgressBar({
  progress,
}: {
  progress: Extract<UpdateProgress, { status: 'running' }>
}): ReactNode {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    // 1Hz, not an animation frame loop: an update takes minutes, and this sits
    // in the strip above the prompt that redraws with it.
    const interval = setInterval(() => setFrame(f => f + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  const percent = overallPercent(progress.stage, progress.percent)
  const filled = Math.round((percent / 100) * BAR_WIDTH)

  return (
    <Box>
      <Text dimColor wrap="truncate">
        {SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} {STAGE_LABEL[progress.stage]}{' '}
        {'█'.repeat(filled)}
        {'░'.repeat(BAR_WIDTH - filled)} {percent}%
        {progress.detail ? ` · ${progress.detail}` : ''}
      </Text>
    </Box>
  )
}

/**
 * Progress for a background source update, in the notification strip above the
 * prompt. Renders nothing unless an update is actually running, which is at
 * most once a day and only for installs made by install.sh.
 */
export function SourceUpdateProgress(): ReactNode {
  const progress = useSyncExternalStore(subscribeUpdateProgress, getUpdateProgress)
  if (progress.status !== 'running') return null
  return <ProgressBar progress={progress} />
}
