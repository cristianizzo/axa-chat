import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalCommandResult } from '../../types/command.js'
import { saveFavorite } from '../../utils/sessionStorage.js'

export async function call(): Promise<LocalCommandResult> {
  await saveFavorite(getSessionId() as UUID, false)
  return { type: 'text', value: 'Session removed from Favorites.' }
}
