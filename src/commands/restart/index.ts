import type { Command } from '../../commands.js'

const restart = {
  type: 'local-jsx',
  name: 'restart',
  aliases: ['reload'],
  description: 'Relaunch axa with the same arguments (e.g. after /update)',
  immediate: true,
  load: () => import('./restart.js'),
} satisfies Command

export default restart
