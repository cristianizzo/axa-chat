import type { Command } from '../../commands.js'
import { PRODUCT_NAME } from '../../constants/product.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: `Show your ${PRODUCT_NAME} usage statistics and activity`,
  load: () => import('./stats.js'),
} satisfies Command

export default stats
