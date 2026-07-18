import React from 'react'
import type { PermissionMode } from '../types/permissions.js'
import { permissionModeTitle } from '../utils/permissions/PermissionMode.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'
import { Box, Text } from '../ink.js'

// The three user-facing approval tiers, in display order.
const TIERS: { value: PermissionMode; description: string }[] = [
  {
    value: 'default', // "Manual approvals"
    description: 'Ask before every tool action (safest).',
  },
  {
    value: 'auto', // "Auto approvals"
    description:
      'Runs on its own; still pauses on risky actions (rm -rf, sensitive files) and questions.',
  },
  {
    value: 'bypassPermissions', // "Skip all approvals"
    description: 'Never pauses, even for unsafe actions.',
  },
]

export type ApprovalModePickerProps = {
  currentMode: PermissionMode
  isBypassAvailable: boolean
  onSelect: (mode: PermissionMode) => void
  onCancel: () => void
}

/**
 * Interactive picker for the three approval tiers (Manual / Auto / Skip all).
 * Shared by the `/mode` command and the ⌘M keyboard shortcut.
 */
export function ApprovalModePicker({
  currentMode,
  isBypassAvailable,
  onSelect,
  onCancel,
}: ApprovalModePickerProps): React.ReactNode {
  const options: OptionWithDescription<PermissionMode>[] = TIERS.map(tier => {
    const unavailable = tier.value === 'bypassPermissions' && !isBypassAvailable
    return {
      label: permissionModeTitle(tier.value),
      value: tier.value,
      description: unavailable
        ? `${tier.description} (disabled by settings)`
        : tier.description,
      disabled: unavailable,
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>Approval level</Text>
      <Select
        options={options}
        defaultValue={currentMode}
        onChange={onSelect}
        onCancel={onCancel}
      />
    </Box>
  )
}
