import type { Command } from '../../commands.js'

const command = {
  name: 'update',
  description: 'Update axa-chat: pull latest, reinstall deps, and rebuild',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./update.js'),
} satisfies Command

export default command
