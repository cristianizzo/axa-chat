import {
  ALL_MODEL_CONFIGS,
  type ModelConfig,
  type ModelKey,
} from './configs.js'

/**
 * Data-driven model registry (P2: "dynamic model registration").
 *
 * Historically, every model capability (1M context, effort, thinking, pricing,
 * output limits, display names, knowledge cutoff) was derived by scattered
 * `model.includes('opus-4-x')` substring checks across ~10 files. That worked
 * only because every shipped model ID contained the `claude-opus-4` /
 * `claude-sonnet-4` prefix — an assumption `claude-opus-5` breaks.
 *
 * This registry makes each 4.5+/5-series model declare its capabilities once.
 * The `modelSupportsX` / name / cost / cutoff helpers consult the registry
 * first (via `getModelDescriptor`) and only fall back to the legacy substring
 * ladders for pre-4.5 models that aren't registered here. Adding a new model is
 * now a single entry below.
 *
 * INVARIANT: values for already-shipped models must exactly reproduce the
 * previous substring-derived behavior — there is no test suite in this fork, so
 * changing a value here silently changes runtime behavior.
 */

export type ModelFamilyName = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos'

/** Pricing tier name — mapped to concrete ModelCosts in modelCost.ts. */
export type PricingTier =
  | 'tier_3_15'
  | 'tier_5_25'
  | 'tier_15_75'
  | 'tier_10_50'
  | 'haiku_35'
  | 'haiku_45'

export type ModelDescriptor = {
  /** Internal short key, mirrors ALL_MODEL_CONFIGS. */
  key: ModelKey
  /** Provider-specific model ID strings. */
  config: ModelConfig
  /**
   * Canonical short name (what firstPartyNameToCanonical returns), e.g.
   * 'claude-opus-4-8'. May differ from config.firstParty when the first-party
   * ID carries a date suffix (e.g. 'claude-opus-4-5-20251101').
   */
  canonical: string
  family: ModelFamilyName
  /** Human-readable name without any context-window suffix, e.g. 'Opus 4.8'. */
  displayName: string
  pricingTier: PricingTier
  supports1M: boolean
  effort: boolean
  maxEffort: boolean
  adaptiveThinking: boolean
  structuredOutputs: boolean
  maxOutput: { readonly default: number; readonly upperLimit: number }
  /** Knowledge cutoff string for the system prompt, or null if none. */
  knowledgeCutoff: string | null
  /**
   * True for the single model that backs the premium "fast mode" (higher-speed
   * serving at premium pricing). Only one model has this at a time; moving fast
   * infra to a new model = moving this flag.
   */
  fastMode?: boolean
}

const OUT_64_128 = { default: 64_000, upperLimit: 128_000 } as const
const OUT_32_128 = { default: 32_000, upperLimit: 128_000 } as const
const OUT_32_64 = { default: 32_000, upperLimit: 64_000 } as const

/**
 * Registry of 4.5+/5-series models. Pre-4.5 models (3.x, 4.0, 4.1) are handled
 * by the legacy substring fallbacks and intentionally omitted.
 *
 * @[MODEL LAUNCH]: Add the new model's descriptor here — this replaces the
 * per-file substring edits that model launches used to require.
 */
export const MODEL_REGISTRY: readonly ModelDescriptor[] = [
  {
    key: 'haiku45',
    config: ALL_MODEL_CONFIGS.haiku45,
    canonical: 'claude-haiku-4-5',
    family: 'haiku',
    displayName: 'Haiku 4.5',
    pricingTier: 'haiku_45',
    supports1M: false,
    effort: false,
    maxEffort: false,
    adaptiveThinking: false,
    structuredOutputs: true,
    maxOutput: OUT_32_64,
    knowledgeCutoff: 'February 2025',
  },
  {
    key: 'opus45',
    config: ALL_MODEL_CONFIGS.opus45,
    canonical: 'claude-opus-4-5',
    family: 'opus',
    displayName: 'Opus 4.5',
    pricingTier: 'tier_5_25',
    supports1M: false,
    effort: false,
    maxEffort: false,
    adaptiveThinking: false,
    structuredOutputs: true,
    maxOutput: OUT_32_64,
    knowledgeCutoff: 'May 2025',
  },
  {
    key: 'opus46',
    config: ALL_MODEL_CONFIGS.opus46,
    canonical: 'claude-opus-4-6',
    family: 'opus',
    displayName: 'Opus 4.6',
    pricingTier: 'tier_5_25',
    supports1M: true,
    effort: true,
    maxEffort: true,
    adaptiveThinking: true,
    structuredOutputs: true,
    maxOutput: OUT_64_128,
    knowledgeCutoff: 'May 2025',
    fastMode: true,
  },
  {
    key: 'opus47',
    config: ALL_MODEL_CONFIGS.opus47,
    canonical: 'claude-opus-4-7',
    family: 'opus',
    displayName: 'Opus 4.7',
    pricingTier: 'tier_5_25',
    supports1M: true,
    effort: true,
    maxEffort: true,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: 'January 2025',
  },
  {
    key: 'opus48',
    config: ALL_MODEL_CONFIGS.opus48,
    canonical: 'claude-opus-4-8',
    family: 'opus',
    displayName: 'Opus 4.8',
    pricingTier: 'tier_5_25',
    supports1M: true,
    effort: true,
    maxEffort: true,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: 'January 2025',
  },
  {
    key: 'opus5',
    config: ALL_MODEL_CONFIGS.opus5,
    canonical: 'claude-opus-5',
    family: 'opus',
    displayName: 'Opus 5',
    pricingTier: 'tier_5_25',
    supports1M: true,
    effort: true,
    maxEffort: true,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: null,
  },
  {
    key: 'sonnet45',
    config: ALL_MODEL_CONFIGS.sonnet45,
    canonical: 'claude-sonnet-4-5',
    family: 'sonnet',
    displayName: 'Sonnet 4.5',
    pricingTier: 'tier_3_15',
    supports1M: true,
    effort: false,
    maxEffort: false,
    adaptiveThinking: false,
    structuredOutputs: true,
    maxOutput: OUT_32_64,
    knowledgeCutoff: 'January 2025',
  },
  {
    key: 'sonnet46',
    config: ALL_MODEL_CONFIGS.sonnet46,
    canonical: 'claude-sonnet-4-6',
    family: 'sonnet',
    displayName: 'Sonnet 4.6',
    pricingTier: 'tier_3_15',
    supports1M: true,
    effort: true,
    maxEffort: false,
    adaptiveThinking: true,
    structuredOutputs: true,
    maxOutput: OUT_32_128,
    knowledgeCutoff: 'August 2025',
  },
  {
    key: 'sonnet5',
    config: ALL_MODEL_CONFIGS.sonnet5,
    canonical: 'claude-sonnet-5',
    family: 'sonnet',
    displayName: 'Sonnet 5',
    pricingTier: 'tier_3_15',
    supports1M: true,
    effort: true,
    maxEffort: false,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: null,
  },
  {
    key: 'fable5',
    config: ALL_MODEL_CONFIGS.fable5,
    canonical: 'claude-fable-5',
    family: 'fable',
    displayName: 'Fable 5',
    pricingTier: 'tier_10_50',
    supports1M: true,
    effort: true,
    maxEffort: false,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: null,
  },
  {
    key: 'mythos5',
    config: ALL_MODEL_CONFIGS.mythos5,
    canonical: 'claude-mythos-5',
    family: 'mythos',
    displayName: 'Mythos 5',
    pricingTier: 'tier_10_50',
    supports1M: true,
    effort: true,
    maxEffort: false,
    adaptiveThinking: true,
    structuredOutputs: false,
    maxOutput: OUT_64_128,
    knowledgeCutoff: null,
  },
]

// Fail fast at module load on registry mistakes the type system can't catch.
// This fork has no test suite, so an inconsistent entry (mismatched key/config,
// a canonical that doesn't belong to its provider IDs, an inverted output range,
// or two fast-mode models) would otherwise ship as silently wrong pricing or
// capabilities. Turning those into a hard startup crash is the cheapest guard.
function assertRegistryInvariants(): void {
  let fastModeCount = 0
  for (const d of MODEL_REGISTRY) {
    if (ALL_MODEL_CONFIGS[d.key] !== d.config) {
      throw new Error(
        `[model registry] '${d.key}': config is not ALL_MODEL_CONFIGS['${d.key}']`,
      )
    }
    // getModelDescriptor matches by canonical substring against whatever
    // provider ID form it's given, so the canonical must be a substring of
    // EVERY provider's ID — not just firstParty — or capability resolution
    // silently breaks for that provider.
    for (const providerId of Object.values(d.config)) {
      if (!providerId.includes(d.canonical)) {
        throw new Error(
          `[model registry] '${d.key}': canonical '${d.canonical}' is not a substring of provider ID '${providerId}'`,
        )
      }
    }
    if (d.maxOutput.default > d.maxOutput.upperLimit) {
      throw new Error(
        `[model registry] '${d.key}': maxOutput.default ${d.maxOutput.default} exceeds upperLimit ${d.maxOutput.upperLimit}`,
      )
    }
    if (d.fastMode) {
      fastModeCount++
    }
  }
  if (fastModeCount > 1) {
    throw new Error(
      `[model registry] ${fastModeCount} descriptors have fastMode=true; expected at most 1`,
    )
  }
  // These families back user-facing "latest models" copy (getLatestModelForFamily);
  // a missing one would silently degrade the system prompt, so fail loudly here.
  for (const family of ['opus', 'sonnet', 'haiku'] as const) {
    if (!MODEL_REGISTRY.some(d => d.family === family)) {
      throw new Error(
        `[model registry] no descriptor for required family '${family}'`,
      )
    }
  }
}
assertRegistryInvariants()

// Order so the most specific canonical is matched first. If one canonical is a
// substring of another (e.g. a hypothetical 'claude-opus-5-1' vs 'claude-opus-5'),
// the container must be tried first regardless of length; length is the tiebreak
// otherwise. This keeps `getModelDescriptor`'s substring match unambiguous.
const REGISTRY_BY_SPECIFICITY = [...MODEL_REGISTRY].sort((a, b) => {
  if (a.canonical === b.canonical) {
    return 0
  }
  if (b.canonical.includes(a.canonical)) {
    return 1
  }
  if (a.canonical.includes(b.canonical)) {
    return -1
  }
  return b.canonical.length - a.canonical.length
})

/**
 * Resolve a model string to its registry descriptor, or undefined for
 * unregistered (pre-4.5) or non-Claude models.
 *
 * Matches by canonical substring, which works across every provider ID form
 * because each provider string for a model contains its canonical name
 * (e.g. 'anthropic.claude-opus-5' ⊃ 'claude-opus-5', and the dated first-party
 * ID 'claude-opus-4-5-20251101' ⊃ 'claude-opus-4-5'). Strips a trailing [1m]
 * tag so 1M variants resolve to the same descriptor.
 *
 * IMPORTANT: pass a resolved model string. This matcher does NOT resolve
 * settings `modelOverrides` (e.g. a Bedrock ARN mapped to 'claude-opus-5') — it
 * only strips a `[1m]` tag and matches by canonical substring. Keeping it free
 * of settings/modelStrings imports keeps this a leaf module (no import cycle).
 * Callers that may hold a raw override string should pass
 * `getCanonicalName(model)` so overrides resolve to the right descriptor.
 */
export function getModelDescriptor(
  model: string | undefined | null,
): ModelDescriptor | undefined {
  if (!model) {
    return undefined
  }
  const normalized = model
    .toLowerCase()
    .replace(/\[1m\]$/i, '')
    .trim()
  return REGISTRY_BY_SPECIFICITY.find(d => normalized.includes(d.canonical))
}

/**
 * Extract [major, minor] version from a canonical name, e.g.
 * 'claude-opus-5' → [5, 0], 'claude-opus-4-8' → [4, 8]. Compared as a tuple
 * (not major*100+minor) so a future two-digit minor can't collide across majors.
 */
function versionParts(canonical: string): [number, number] {
  const match = canonical.match(/-(\d+)(?:-(\d+))?$/)
  if (!match) {
    return [0, 0]
  }
  return [
    Number.parseInt(match[1] ?? '0', 10),
    match[2] ? Number.parseInt(match[2], 10) : 0,
  ]
}

/**
 * Newest registered (public) model in a family, e.g. 'opus' → Opus 5.
 * Used for user-facing "latest models" copy that must never reference an
 * internal codename, so it reads from the public registry rather than the
 * runtime default (which can be a codename for ants).
 */
export function getLatestModelForFamily(
  family: ModelFamilyName,
): ModelDescriptor | undefined {
  return MODEL_REGISTRY.filter(d => d.family === family).sort((a, b) => {
    const [aMajor, aMinor] = versionParts(a.canonical)
    const [bMajor, bMinor] = versionParts(b.canonical)
    return bMajor - aMajor || bMinor - aMinor
  })[0]
}

/** The single model that currently backs premium fast mode, if any. */
export function getFastModeModelDescriptor(): ModelDescriptor | undefined {
  return MODEL_REGISTRY.find(d => d.fastMode === true)
}
