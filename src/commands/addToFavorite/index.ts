import type { Command } from '../../commands.js'

const addToFavorite = {
  type: 'local',
  name: 'addToFavorite',
  description: 'Add the current session to Favorites',
  supportsNonInteractive: false,
  load: () => import('./addToFavorite.js'),
} satisfies Command

export default addToFavorite
