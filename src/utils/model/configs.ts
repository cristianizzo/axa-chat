import {
  DEFAULT_CODEX_MODEL,
  type CodexModelId,
} from 'src/config/codex.js'
import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
  openai: 'claude-3-7-sonnet-20250219',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
  openai: 'claude-3-5-sonnet-20241022',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
  openai: 'claude-3-5-haiku-20241022',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
  openai: 'claude-haiku-4-5-20251001',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
  openai: 'claude-sonnet-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
  openai: 'claude-sonnet-4-5-20250929',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
  openai: 'claude-opus-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
  openai: 'claude-opus-4-1-20250805',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
  openai: 'claude-opus-4-5-20251101',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
  openai: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
  openai: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_7_CONFIG = {
  firstParty: 'claude-opus-4-7',
  bedrock: 'anthropic.claude-opus-4-7',
  vertex: 'claude-opus-4-7',
  foundry: 'claude-opus-4-7',
  openai: 'claude-opus-4-7',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'anthropic.claude-opus-4-8',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
  openai: 'claude-opus-4-8',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_CONFIG = {
  firstParty: 'claude-sonnet-5',
  bedrock: 'anthropic.claude-sonnet-5',
  vertex: 'claude-sonnet-5',
  foundry: 'claude-sonnet-5',
  openai: 'claude-sonnet-5',
} as const satisfies ModelConfig

export const CLAUDE_FABLE_5_CONFIG = {
  firstParty: 'claude-fable-5',
  bedrock: 'anthropic.claude-fable-5',
  vertex: 'claude-fable-5',
  foundry: 'claude-fable-5',
  openai: 'claude-fable-5',
} as const satisfies ModelConfig

export const CLAUDE_MYTHOS_5_CONFIG = {
  firstParty: 'claude-mythos-5',
  bedrock: 'anthropic.claude-mythos-5',
  vertex: 'claude-mythos-5',
  foundry: 'claude-mythos-5',
  openai: 'claude-mythos-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_CONFIG = {
  firstParty: 'claude-opus-5',
  bedrock: 'anthropic.claude-opus-5',
  vertex: 'claude-opus-5',
  foundry: 'claude-opus-5',
  openai: 'claude-opus-5',
} as const satisfies ModelConfig

// NOTE: Bedrock IDs for new models use the dateless format (e.g. 'anthropic.claude-opus-4-8')
// matching the pattern from Anthropic docs. The modelStrings.ts findFirstMatch() will resolve
// these against actual Bedrock inference profiles at runtime. If a model is not yet available
// on Bedrock, the fallback ID is used and the API will return an appropriate error.

// OpenAI Codex models
/**
 * Codex models use the same ID on every provider, unlike Claude models whose ID
 * is rewritten per provider. Accepting a {@link CodexModelId} ties these configs
 * to the Codex registry, so an ID that is not actually offered fails the build.
 *
 * @param id - The Codex model ID
 * @returns A ModelConfig carrying that ID for every provider
 */
function codexConfig<T extends CodexModelId>(id: T) {
  return {
    firstParty: id,
    bedrock: id,
    vertex: id,
    foundry: id,
    openai: id,
  } as const satisfies ModelConfig
}

export const GPT_5_6_SOL_CONFIG = codexConfig('gpt-5.6-sol')
export const GPT_5_6_TERRA_CONFIG = codexConfig(DEFAULT_CODEX_MODEL)
export const GPT_5_6_LUNA_CONFIG = codexConfig('gpt-5.6-luna')
export const GPT_5_5_CONFIG = codexConfig('gpt-5.5')
export const GPT_5_2_CONFIG = codexConfig('gpt-5.2')

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  opus47: CLAUDE_OPUS_4_7_CONFIG,
  opus48: CLAUDE_OPUS_4_8_CONFIG,
  opus5: CLAUDE_OPUS_5_CONFIG,
  sonnet5: CLAUDE_SONNET_5_CONFIG,
  fable5: CLAUDE_FABLE_5_CONFIG,
  mythos5: CLAUDE_MYTHOS_5_CONFIG,
  // OpenAI Codex models
  gpt56sol: GPT_5_6_SOL_CONFIG,
  gpt56terra: GPT_5_6_TERRA_CONFIG,
  gpt56luna: GPT_5_6_LUNA_CONFIG,
  gpt55: GPT_5_5_CONFIG,
  gpt52: GPT_5_2_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
