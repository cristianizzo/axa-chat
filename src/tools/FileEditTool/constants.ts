// In its own file to avoid circular dependencies
import { CONFIG_DIR_NAME } from '../../constants/product.js'

export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's own
// config folder. checkWritePermissionForTool step 1.6 only honours a session
// rule whose content starts with one of these patterns, so this must match the
// real directory name or the escape hatch becomes unreachable.
export const PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN = `/${CONFIG_DIR_NAME}/**`

// Home-level grant for our own config dir. Shared with a Claude Code install
// by design — one directory, one grant.
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = `~/${CONFIG_DIR_NAME}/**`

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
