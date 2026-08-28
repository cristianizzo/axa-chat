import type { Command } from '../../commands.js'

const projects = {
  type: 'local-jsx',
  name: 'projects',
  description: 'List stored projects with their size, conversations and path',
  load: () => import('./projects.js'),
} satisfies Command

export default projects
