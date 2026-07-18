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
  const ctx = context.getAppState().toolPermissionContext

  function onSelect(next: PermissionMode) {
    if (next === ctx.mode) {
      onDone(`Already in ${permissionModeTitle(ctx.mode)}.`)
      return
    }
    const preparedCtx = transitionPermissionMode(ctx.mode, next, ctx)
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: { ...preparedCtx, mode: next },
    }))
    onDone(`Switched to ${permissionModeTitle(next)}.`)
  }

  return (
    <ApprovalModePicker
      currentMode={ctx.mode}
      isBypassAvailable={ctx.isBypassPermissionsModeAvailable}
      onSelect={onSelect}
      onCancel={() => onDone()}
    />
  )
}
