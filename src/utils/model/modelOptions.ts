// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  isClaudeAISubscriber,
  isCodexSubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import {
  COST_TIER_3_15,
  COST_HAIKU_35,
  COST_HAIKU_45,
  formatModelPricing,
} from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getAPIProvider } from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpus46PricingSuffix,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext } from '../context.js'
import { getGlobalConfig } from '../config.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

// ── Helpers to resolve the current marketing name for each model family ──
function defaultSonnetName(): string {
  return getMarketingNameForModel(getDefaultSonnetModel()) ?? 'Sonnet'
}
function defaultOpusName(): string {
  return getMarketingNameForModel(getDefaultOpusModel()) ?? 'Opus'
}
function defaultHaikuName(): string {
  return getMarketingNameForModel(getDefaultHaikuModel()) ?? 'Haiku'
}

// @[MODEL LAUNCH]: Options derive labels dynamically via defaultSonnetName()/defaultOpusName().
// Add new version entries to getAllVersionOptions() for the picker.
function getSonnetOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const sonnetModel = getDefaultSonnetModel()
  const name = defaultSonnetName()
  return {
    value: is3P ? sonnetModel : 'sonnet',
    label: 'Sonnet',
    description: `${name} · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      `${name} - best for everyday tasks. Generally recommended for most coding tasks`,
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

function getOpus41Option(): ModelOption {
  return {
    value: 'opus',
    label: 'Opus 4.1',
    description: `Opus 4.1 · Legacy`,
    descriptionForModel: 'Opus 4.1 - legacy version',
  }
}

function getOpusOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const opusModel = getDefaultOpusModel()
  const name = defaultOpusName()
  return {
    value: is3P ? opusModel : 'opus',
    label: 'Opus',
    description: `${name} · Most capable for complex work${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: `${name} - most capable for complex work`,
  }
}

export function getSonnet1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const sonnetModel = getDefaultSonnetModel()
  const name = defaultSonnetName()
  return {
    value: is3P ? sonnetModel + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `${name} for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      `${name} with 1M context window - for long sessions with large codebases`,
  }
}

export function getOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const opusModel = getDefaultOpusModel()
  const name = defaultOpusName()
  return {
    value: is3P ? opusModel + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${name} for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel:
      `${name} with 1M context window - for long sessions with large codebases`,
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  // When a 3P user has a custom haiku model string, show it directly
  if (is3P && customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet.',
  }
}

function getHaiku35Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 3.5 for simple tasks${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_35)}`}`,
    descriptionForModel:
      'Haiku 3.5 - faster and lower cost, but less capable than Sonnet. Use for simple tasks.',
  }
}

function getHaikuOption(): ModelOption {
  // Return correct Haiku option based on provider
  const haikuModel = getDefaultHaikuModel()
  return haikuModel === getModelStrings().haiku45
    ? getHaiku45Option()
    : getHaiku35Option()
}

// OpenAI Codex model options
function getGpt54Option(): ModelOption {
  return {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'GPT-5.4 · Advanced reasoning and code generation',
    descriptionForModel: 'GPT-5.4 - advanced reasoning and code generation capabilities',
  }
}

function getGpt53CodexOption(): ModelOption {
  return {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'GPT-5.3 Codex · Optimized for code generation and understanding',
    descriptionForModel: 'GPT-5.3 Codex - specialized for code generation and understanding',
  }
}

function getGpt54MiniOption(): ModelOption {
  return {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'GPT-5.4 Mini · Fast and efficient for simple tasks',
    descriptionForModel: 'GPT-5.4 Mini - fast and efficient for simple coding tasks',
  }
}

function getMaxOpusOption(fastMode = false): ModelOption {
  const name = defaultOpusName()
  return {
    value: 'opus',
    label: 'Opus',
    description: `${name} · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  const name = defaultSonnetName()
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `${name} with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

export function getMaxOpus1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  const name = defaultOpusName()
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${name} with 1M context${billingInfo}${getOpus46PricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const opusModel = getDefaultOpusModel()
  const name = defaultOpusName()
  return {
    value: is3P ? opusModel + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `${name} with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus46PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      `${name} with 1M context - most capable for complex work`,
  }
}

function getMaxSonnetOption(): ModelOption {
  const name = defaultSonnetName()
  return {
    value: 'sonnet',
    label: 'Sonnet',
    description: `${name} · Best for everyday tasks`,
  }
}

function getMaxHaikuOption(): ModelOption {
  const name = defaultHaikuName()
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `${name} · Fastest for quick answers`,
  }
}

function getOpusPlanOption(): ModelOption {
  const opusName = defaultOpusName()
  const sonnetName = defaultSonnetName()
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: `Use ${opusName} in plan mode, ${sonnetName} otherwise`,
  }
}

// ── Model family & version structure for two-level picker ──────────────

export type ModelFamily = {
  key: string
  label: string
  description: string
  versions: ModelOption[]
}

export function getModelFamilies(): ModelFamily[] {
  const s = getModelStrings()
  return [
    {
      key: 'opus',
      label: 'Opus',
      description: '$5/$25 · Most capable for complex work',
      versions: [
        { value: s.opus48, label: 'Opus 4.8', description: '1M context · 128k output · Agentic coding & enterprise' },
        { value: s.opus47, label: 'Opus 4.7', description: '1M context · 128k output · Agentic coding' },
        { value: s.opus46, label: 'Opus 4.6', description: '1M context · 128k output · Previous default' },
      ],
    },
    {
      key: 'sonnet',
      label: 'Sonnet',
      description: '$3/$15 · Best speed/intelligence balance',
      versions: [
        { value: s.sonnet5, label: 'Sonnet 5', description: '1M context · 128k output · Latest' },
        { value: s.sonnet46, label: 'Sonnet 4.6', description: '1M context · 128k output · Previous default' },
      ],
    },
    {
      key: 'fable',
      label: 'Fable',
      description: '$10/$50 · Next-gen long-running agents',
      versions: [
        { value: s.fable5, label: 'Fable 5', description: '1M context · 128k output · Most advanced' },
      ],
    },
    {
      key: 'haiku',
      label: 'Haiku',
      description: '$1/$5 · Fastest for quick answers',
      versions: [
        { value: s.haiku45, label: 'Haiku 4.5', description: '200k context · 64k output' },
      ],
    },
  ]
}

/** Family option values — intercepted by the two-level picker to show versions. */
export const FAMILY_PREFIX = '__family_'

// @[MODEL LAUNCH]: Add new families to getModelOptionsBase() and getModelFamilies().
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))
    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
    ]
  }

  if (isCodexSubscriber()) {
    return [
      getDefaultOptionForUser(),
      getGpt54Option(),
      getGpt53CodexOption(),
      getGpt54MiniOption(),
    ]
  }

  // All Claude users (subscribers + PAYG): Default + family pickers
  const families = getModelFamilies()
  const familyOptions: ModelOption[] = families.map(f => ({
    value: `${FAMILY_PREFIX}${f.key}`,
    label: f.label,
    description: `${f.description} · Select version`,
  }))

  return [
    getDefaultOptionForUser(fastMode),
    ...familyOptions,
  ]
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

/**
 * Model options for the /model picker UI — quick picks (family defaults).
 * Version selection is handled by the two-level picker via getModelFamilies().
 */
export function getModelPickerOptions(fastMode = false): ModelOption[] {
  return getModelOptionsInternal(fastMode)
}

/**
 * Model options for non-picker consumers (config, settings, CLI).
 */
export function getModelOptions(fastMode = false): ModelOption[] {
  return getModelOptionsInternal(fastMode)
}

function getModelOptionsInternal(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (customModel === null || options.some(opt => opt.value === customModel)) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
