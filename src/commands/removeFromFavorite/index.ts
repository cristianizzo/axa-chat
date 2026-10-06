import type { Command } from '../../commands.js'

const removeFromFavorite = {
  type: 'local',
  name: 'removeFromFavorite',
  description: 'Remove the current session from Favorites',
  supportsNonInteractive: false,
  load: () => import('./removeFromFavorite.js'),
} satisfies Command

export default removeFromFavorite
