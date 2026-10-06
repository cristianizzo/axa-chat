import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'switch-account',
  description: 'Switch between accounts you are already signed in to',
  argumentHint: '[provider] [--session]',
  load: () => import('./switchAccount.js'),
} satisfies Command
