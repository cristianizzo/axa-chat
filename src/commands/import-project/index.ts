import type { Command } from '../../commands.js'
import {
  CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  LEGACY_MEMORY_FILE_NAME,
  MEMORY_FILE_NAME,
} from '../../constants/product.js'

const importProject = {
  type: 'local-jsx',
  name: 'import-project',
  description: `Copy this project's ${LEGACY_MEMORY_FILE_NAME} and ${LEGACY_CONFIG_DIR_NAME}/ into ${MEMORY_FILE_NAME} and ${CONFIG_DIR_NAME}/`,
  load: () => import('./import-project.js'),
} satisfies Command

export default importProject
