/**
 * Removing thinking blocks the account now serving the session did not sign.
 *
 * Kept in its own module because it is the one place that joins
 * `utils/messages.ts` (which knows what a signature-bearing block is) to
 * `utils/model/model.ts` (which knows which account is live). Neither imports
 * the other, so the join cannot live in either of them.
 */

import type { Message } from '../types/message.js'
import { stripSignatureBlocksWhere } from './messages.js'
import {
  isRetiredModelOfActiveProvider,
  isServableByActiveProvider,
} from './model/model.js'

/**
 * Whether an assistant message was produced by some account other than the one
 * now serving the session.
 *
 * Acts only on positive evidence. `model` is typed as a string, but these
 * records are replayed from a transcript on disk — the very case this exists
 * for — so an old or SDK-authored one can arrive without it, and
 * isServableByActiveProvider throws on a non-string.
 *
 * "Cannot serve it" is the test, with one exception: an ID the active provider
 * itself retired is unservable but not foreign, and stripping it would throw
 * away the session's own thinking.
 */
function isFromAnotherAccount(model: unknown): boolean {
  if (typeof model !== 'string') return false
  if (isServableByActiveProvider(model)) return false
  return !isRetiredModelOfActiveProvider(model)
}

/**
 * Drops thinking/redacted_thinking/connector_text left by an account that is no
 * longer the one serving this session.
 *
 * Their signatures are credential-bound, so replaying them 400s with
 * "Invalid `signature` in `thinking` block" on every turn until the transcript
 * is cleaned.
 *
 * `/login` and `/switch-account` already strip in-session, but the active
 * account lives in *global* config (utils/activeAuthProvider.ts): switching in
 * one window silently repoints every other running session, and a resumed
 * session adopts whatever account is current rather than the one that recorded
 * the transcript. Neither path runs those strips, so this has to happen on the
 * request itself, where it re-runs every turn and cannot go stale.
 *
 * Keyed on `message.model` so the current account keeps its own blocks:
 * stripping unconditionally would discard the extended thinking the model is
 * still reasoning from. A message whose origin cannot be established keeps its
 * blocks — that is today's behaviour, and getAssistantMessageFromError names
 * the recovery if the API then rejects them.
 *
 * @returns The input untouched when nothing is foreign, so a single-account
 * session keeps a byte-identical prefix and its prompt cache.
 */
export function stripForeignSignatureBlocks<T extends Message>(
  messages: T[],
): T[] {
  return stripSignatureBlocksWhere(messages, msg =>
    isFromAnotherAccount(msg.message.model),
  )
}
