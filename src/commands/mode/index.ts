import type { Command } from '../../commands.js'

const command = {
  name: 'mode',
  aliases: ['approvals'],
  description: 'Choose approval level: manual, auto, or skip-all',
  immediate: true,
  type: 'local-jsx',
  load: () => import('./mode.js'),
} satisfies Command

export default command
