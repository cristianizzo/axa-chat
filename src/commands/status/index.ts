import type { Command } from '../../commands.js'
import { PRODUCT_NAME } from '../../constants/product.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    `Show ${PRODUCT_NAME} status including version, model, account, API connectivity, and tool statuses`,
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
