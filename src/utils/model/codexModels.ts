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

export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex'

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
