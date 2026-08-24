import { useEffect, useSyncExternalStore } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import {
  clearUpdateProgress,
  getUpdateProgress,
  subscribeUpdateProgress,
} from '../../utils/sourceUpdate.js'

/**
 * Announces a background update once its new binary has been swapped in. The
 * swap itself is invisible — the running process keeps the build it started
 * from — so without this the user would only discover the update by restarting.
 */
export function useSourceUpdateNotification(): void {
  const { addNotification } = useNotifications()
  const progress = useSyncExternalStore(subscribeUpdateProgress, getUpdateProgress)

  useEffect(() => {
    if (progress.status !== 'ready') return
    addNotification({
      key: 'source-update-ready',
      text: `Updated to ${progress.sha} · restart axa to use the new build`,
      priority: 'medium',
      timeoutMs: 30_000,
    })
    // Back to idle so the progress bar unmounts and this fires only once.
    clearUpdateProgress()
  }, [progress, addNotification])
}
