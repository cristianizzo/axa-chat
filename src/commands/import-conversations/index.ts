import type { Command } from '../../commands.js'

const importConversations = {
  type: 'local-jsx',
  name: 'import-conversations',
  description:
    'Import conversations, settings and login from an existing Claude Code installation',
  load: () => import('./import-conversations.js'),
} satisfies Command

export default importConversations
