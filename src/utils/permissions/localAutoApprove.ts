/**
 * Local (network-free) risk detection for "Auto approvals" mode.
 *
 * Auto mode runs the agent autonomously by turning permission `ask` decisions
 * into `allow`. It must still pause on genuinely risky actions. Because this
 * fork has no access to the remote transcript classifier, we approximate "risky"
 * with deterministic, local signals only:
 *
 *   1. `safetyCheck` decisions — sensitive files/dirs (.git/, .claude/, .env,
 *      shell rc files) flagged by the filesystem safety layer.
 *   2. Destructive shell commands — rm -rf, force-push, DROP TABLE, kubectl
 *      delete, terraform destroy, etc. (via getDestructiveCommandWarning).
 *   3. PowerShell — always treated as risky in auto mode (download-and-execute
 *      patterns like `iex (iwr ...)` can't be judged locally).
 *
 * This is best-effort: local pattern matching cannot catch every dangerous
 * command the way an AI classifier could. Users who want every action reviewed
 * should use Manual approvals; users who want nothing reviewed can use Skip all.
 */

import { getDestructiveCommandWarning } from '../../tools/BashTool/destructiveCommandWarning.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'

/**
 * Returns true when an action that would normally prompt should STILL prompt in
 * auto mode because a local safety signal flags it as risky.
 */
export function isLocallyRiskyAction(
  toolName: string,
  input: unknown,
  decisionReason: PermissionDecisionReason | undefined,
): boolean {
  // Sensitive-file / dangerous-path safety checks always re-prompt in auto mode.
  if (decisionReason?.type === 'safetyCheck') {
    return true
  }

  // PowerShell can't be judged locally — keep it interactive in auto mode.
  if (toolName === POWERSHELL_TOOL_NAME) {
    return true
  }

  // Destructive shell commands (rm -rf, git push --force, DROP TABLE, ...).
  if (toolName === BASH_TOOL_NAME) {
    const command = (input as { command?: unknown })?.command
    if (
      typeof command === 'string' &&
      getDestructiveCommandWarning(command) !== null
    ) {
      return true
    }
  }

  return false
}
