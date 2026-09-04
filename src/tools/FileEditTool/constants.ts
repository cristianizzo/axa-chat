// In its own file to avoid circular dependencies
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
} from '../../constants/product.js'

export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's own
// config folder. This fork's project config dir is CONFIG_DIR_NAME ('.axa'),
// not '.claude' — the two scopes were unified deliberately (see
// constants/product.ts). Spelling it '.claude' here made the escape hatch
// unreachable: checkWritePermissionForTool step 1.6 only honours a session
// rule whose content starts with one of these patterns, so a grant for
// <project>/.axa/** could never be issued at all.
export const PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN = `/${CONFIG_DIR_NAME}/**`

// The pre-rename project config folder, kept alongside rather than replaced.
// LEGACY_CONFIG_DIR_NAME is still in DANGEROUS_DIRECTORIES on purpose, for
// projects that predate the rename and keep live config there — so those
// projects still need an escape hatch of their own. Dropping this would take
// the "allow edits for this session" option away from exactly the projects
// that have no '.axa' to move to yet.
export const LEGACY_PROJECT_CONFIG_FOLDER_PERMISSION_PATTERN = `/${LEGACY_CONFIG_DIR_NAME}/**`

// Permission pattern for granting session-level access to our own config dir.
// Home-level, so it is ours: `~/.claude/**` would grant edits to a Claude Code
// install's settings and hooks while leaving our own unmatched.
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = `~/${CONFIG_DIR_NAME}/**`

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
