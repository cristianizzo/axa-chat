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
