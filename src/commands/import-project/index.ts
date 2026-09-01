import type { Command } from '../../commands.js'
import { LEGACY_CONFIG_DIR_NAME } from '../../constants/product.js'

const importProject = {
  type: 'local-jsx',
  name: 'import-project',
  // Deliberately not a list of the four filenames: the dialog enumerates what
  // it actually found, and a list here would be one more thing to keep in step
  // with the importable set.
  description: `Copy this project's Claude Code memory files and ${LEGACY_CONFIG_DIR_NAME}/ into axa's`,
  load: () => import('./import-project.js'),
} satisfies Command

export default importProject
