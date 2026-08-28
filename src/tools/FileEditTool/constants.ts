// In its own file to avoid circular dependencies
import { CONFIG_DIR_NAME } from '../../constants/product.js'

export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claude/ folder.
// Project-local, so it keeps the upstream name — those files are committed and
// read by other tools.
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// Permission pattern for granting session-level access to our own config dir.
// Home-level, so it is ours: `~/.claude/**` would grant edits to a Claude Code
// install's settings and hooks while leaving our own unmatched.
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = `~/${CONFIG_DIR_NAME}/**`

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
