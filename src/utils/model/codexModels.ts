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
