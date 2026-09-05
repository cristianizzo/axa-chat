import { homedir } from 'os';
import { basename, join, sep } from 'path';
import React, { type ReactNode } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { ASSISTANT_NAME, CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME } from '../../../constants/product.js';
import { Text } from '../../../ink.js';
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { expandPath, getDirectoryForPath } from '../../../utils/path.js';
import { normalizeCaseForComparison, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
function isInFolder(filePath: string, folderPath: string): boolean {
  const normalizedAbsolutePath = normalizeCaseForComparison(expandPath(filePath));
  const normalizedFolderPath = normalizeCaseForComparison(folderPath);

  // Path must start with the folder path (and be inside it, not just the folder itself)
  return normalizedAbsolutePath.startsWith(normalizedFolderPath + sep.toLowerCase()) ||
  // Also match case where sep is / on posix systems
  normalizedAbsolutePath.startsWith(normalizedFolderPath + '/');
}

/**
 * Which project-scope config folder a path sits in, if any.
 *
 * Two spellings, because this fork's project config dir is CONFIG_DIR_NAME
 * ('.axa') but LEGACY_CONFIG_DIR_NAME ('.claude') is still protected for
 * projects that predate the rename. The returned scope decides which pattern
 * usePermissionHandler writes, and a rule for the wrong spelling would match
 * nothing — an option that appears to grant access and does not.
 */
export function getProjectConfigFolderScope(filePath: string): 'project-config-folder' | 'legacy-project-config-folder' | null {
  if (isInFolder(filePath, expandPath(join(getOriginalCwd(), CONFIG_DIR_NAME)))) {
    return 'project-config-folder';
  }
  if (isInFolder(filePath, expandPath(join(getOriginalCwd(), LEGACY_CONFIG_DIR_NAME)))) {
    return 'legacy-project-config-folder';
  }
  return null;
}

/**
 * Check if a path is within our own home config folder.
 * This is used to determine whether to show the special config-folder permission
 * option for files in the user's home directory.
 *
 * Kept in step with GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN: this decides
 * whether the option is offered, that constant is the rule it writes, so a
 * mismatch would offer an option that grants nothing.
 */
export function isInGlobalConfigFolder(filePath: string): boolean {
  return isInFolder(filePath, join(homedir(), CONFIG_DIR_NAME));
}
export type ConfigFolderScope = 'project-config-folder' | 'legacy-project-config-folder' | 'global-config-folder';
export type PermissionOption = {
  type: 'accept-once';
} | {
  type: 'accept-session';
  scope?: ConfigFolderScope;
} | {
  type: 'reject';
};
export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption;
};
export type FileOperationType = 'read' | 'write' | 'create';
export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false
}: {
  filePath: string;
  toolPermissionContext: ToolPermissionContext;
  operationType?: FileOperationType;
  onRejectFeedbackChange?: (value: string) => void;
  onAcceptFeedbackChange?: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = [];
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: 'Yes',
      value: 'yes',
      placeholder: 'and tell Claude what to do next',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'accept-once'
      }
    });
  } else {
    options.push({
      label: 'Yes',
      value: 'yes',
      option: {
        type: 'accept-once'
      }
    });
  }
  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext);

  // Check if this is a config folder path (project, legacy project, or global)
  const projectConfigFolderScope = getProjectConfigFolderScope(filePath);
  const inGlobalConfigFolder = isInGlobalConfigFolder(filePath);

  // Option 2: for a config folder — project `.axa`, legacy project `.claude`, or
  // the global `~/.axa` — offer the config-folder option instead of the generic
  // session one. The legacy spelling is one of the three cases, not the subject.
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if ((projectConfigFolderScope !== null || inGlobalConfigFolder) && operationType !== 'read') {
    options.push({
      label: `Yes, and allow ${ASSISTANT_NAME} to edit its own settings for this session`,
      value: 'yes-config-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalConfigFolder ? 'global-config-folder' : projectConfigFolderScope!
      }
    });
  } else {
    // Option 2: Allow all changes/reads during session
    let sessionLabel: ReactNode;
    if (inAllowedPath) {
      // Inside working directory
      if (operationType === 'read') {
        sessionLabel = 'Yes, during this session';
      } else {
        sessionLabel = <Text>
            Yes, allow all edits during this session{' '}
            <Text bold>({modeCycleShortcut})</Text>
          </Text>;
      }
    } else {
      // Outside working directory - include directory name
      const dirPath = getDirectoryForPath(filePath);
      const dirName = basename(dirPath) || 'this directory';
      if (operationType === 'read') {
        sessionLabel = <Text>
            Yes, allow reading from <Text bold>{dirName}/</Text> during this
            session
          </Text>;
      } else {
        sessionLabel = <Text>
            Yes, allow all edits in <Text bold>{dirName}/</Text> during this
            session <Text bold>({modeCycleShortcut})</Text>
          </Text>;
      }
    }
    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: {
        type: 'accept-session'
      }
    });
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: 'No',
      value: 'no',
      placeholder: 'and tell Claude what to do differently',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'reject'
      }
    });
  } else {
    // Not in input mode - simple option
    options.push({
      label: 'No',
      value: 'no',
      option: {
        type: 'reject'
      }
    });
  }
  return options;
}
