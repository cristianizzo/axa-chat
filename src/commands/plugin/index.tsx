import type { Command } from '../../commands.js';
import { PRODUCT_NAME } from '../../constants/product.js';
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: `Manage ${PRODUCT_NAME} plugins`,
  immediate: true,
  load: () => import('./plugin.js')
} satisfies Command;
export default plugin;
