import React from 'react'
import { ApprovalModePicker } from '../../components/ApprovalModePicker.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { ToolUseContext } from '../../Tool.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { transitionPermissionMode } from '../../utils/permissions/permissionSetup.js'

type ModeCommandContext = ToolUseContext & LocalJSXCommandContext

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ModeCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  // Snapshot for the initial render only; the actual transition below reads
  // fresh state from the setAppState updater so it can't act on stale context.
  const initialCtx = context.getAppState().toolPermissionContext

  function onSelect(next: PermissionMode) {
    if (next === context.getAppState().toolPermissionContext.mode) {
      onDone(`Already in ${permissionModeTitle(next)}.`)
      return
    }
    context.setAppState(prev => {
      const prevCtx = prev.toolPermissionContext
      const preparedCtx = transitionPermissionMode(prevCtx.mode, next, prevCtx)
      return {
        ...prev,
        toolPermissionContext: { ...preparedCtx, mode: next },
      }
    })
    onDone(`Switched to ${permissionModeTitle(next)}.`)
  }

  return (
    <ApprovalModePicker
      currentMode={initialCtx.mode}
      isBypassAvailable={initialCtx.isBypassPermissionsModeAvailable}
      onSelect={onSelect}
      onCancel={() => onDone()}
    />
  )
}
