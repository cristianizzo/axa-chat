/**
 * Codex model registry.
 *
 * Deliberately dependency-free: both the `/model` picker (modelOptions.ts) and
 * the networking layer (services/api/codex-fetch-adapter.ts) read from here, so
 * the picker does not have to pull in the fetch adapter — and its transitive
 * dependencies — just to list model names.
 */

// Single source of truth for the `/model` picker (see getCodexModelOptions in
// modelOptions.ts). Adding an entry here surfaces it in the picker.
// Not exhaustive: any other `gpt-*` ID the user types is passed through to the
// backend untouched (see mapClaudeModelToCodex), so a newly launched model
// works without a code change.
export const CODEX_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Latest frontier model · reasoning, coding and agentic work' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast and efficient for simple tasks' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Agentic coding model' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Previous agentic coding model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Max Codex model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast Codex model' },
] as const

/** The ID of any model listed above. */
export type CodexModelId = (typeof CODEX_MODELS)[number]['id']

export const DEFAULT_CODEX_MODEL: CodexModelId = 'gpt-5.3-codex'

/**
 * Capability tiers, used to pick a Codex counterpart when the user is in Codex
 * mode with a Claude model still selected.
 *
 * Keyed by Claude family rather than by an abstract tier name because that is
 * the only thing it is ever used for. The `satisfies` clause ties each value to
 * {@link CODEX_MODELS}, so retiring a model from the list above breaks the
 * build here instead of silently mapping Opus onto a model we no longer offer.
 */
export const CLAUDE_FAMILY_TO_CODEX_MODEL = {
  opus: 'gpt-5.1-codex-max',
  sonnet: DEFAULT_CODEX_MODEL,
  haiku: 'gpt-5.1-codex-mini',
} as const satisfies Record<string, CodexModelId>

/**
 * Input-token context window for Codex models, per OpenAI's own model catalog
 * (codex-rs/models-manager/models.json). Every model listed above reports the
 * same value, so this is a constant rather than a per-model field.
 *
 * Input-only: the API docs quote a *total* of 400k, which is this plus 128k of
 * output. Do not conflate the two.
 *
 * Note this is the subscription figure. gpt-5.4 allows 922k input on the
 * metered platform API, but the ChatGPT backend caps it here and bills 2x
 * beyond it, so the larger number must not be used on this path.
 */
export const CODEX_CONTEXT_WINDOW = 272_000

/**
 * Output-token limits shared by the Codex models above. The ceiling is what the
 * backend allows (400k total - 272k input); the default is the lower value we
 * actually request per turn, matching how the Claude 5-series is configured —
 * asking for the full ceiling every turn would reserve budget nothing uses.
 */
export const CODEX_MAX_OUTPUT_TOKENS = {
  default: 64_000,
  upperLimit: 128_000,
} as const

/**
 * True for any model that will be routed to the Codex backend.
 *
 * Broader than a CODEX_MODELS lookup on purpose: `mapClaudeModelToCodex`
 * forwards any other `gpt-*` ID untouched, so capability checks must agree
 * with that rather than only recognising the six listed models.
 *
 * @param model - A model ID
 * @returns Whether the model runs on Codex
 */
export function isCodexModelId(model: string): boolean {
  const m = model.toLowerCase()
  return m.startsWith('gpt-') || m.includes('codex')
}

/**
 * The display label for a listed Codex model.
 *
 * Both the picker and every display-name path read this, so a model cannot be
 * offered under one name and rendered under another.
 *
 * @param model - A model ID
 * @returns The label, or undefined for an unlisted (passthrough) model
 */
export function getCodexModelLabel(model: string): string | undefined {
  const m = model.toLowerCase()
  return CODEX_MODELS.find(entry => entry.id === m)?.label
}

/**
 * Longest ID first, so a prefix never shadows a more specific model.
 * 'gpt-5.4-mini' contains 'gpt-5.4'; scanning in list order would resolve the
 * mini model to the flagship.
 */
const CODEX_IDS_BY_SPECIFICITY: readonly CodexModelId[] = [
  ...CODEX_MODELS.map(entry => entry.id),
].sort((a, b) => b.length - a.length)

/**
 * Extracts the bare Codex model ID from a string that embeds one.
 *
 * Callers may hold a decorated form (a `[1m]` suffix, a provider prefix), so
 * this matches on substring rather than equality.
 *
 * @param model - A model string that may contain a Codex ID
 * @returns The canonical ID, or undefined if none of the listed models appear
 */
export function findCodexModelId(model: string): CodexModelId | undefined {
  const m = model.toLowerCase()
  return CODEX_IDS_BY_SPECIFICITY.find(id => m.includes(id))
}
