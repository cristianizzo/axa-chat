// Critical system constants extracted to break circular dependencies

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'
import { ANTHROPIC_COMPAT_CLAUDE_CODE_VERSION } from './anthropicClientVersion.js'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Check if attribution header is enabled.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_attribution_header', true)
}

// Backends that actually run Claude models and whose server validates the
// cch/fingerprint scheme (see fingerprint.ts). Everything else — Codex, Grok,
// DeepSeek, Kimi, Ollama — ignores the header outright, so sending it there
// buys nothing. For Ollama specifically it is actively harmful: this text is
// not a real HTTP header, it is spliced into the system PROMPT (see below),
// and the fingerprint third of it is derived from conversation content, so it
// changes from one turn to the next. Ollama's native `/api/chat` cache keys
// on an exact prefix match of that prompt text, so a value this volatile sits
// at the very front and invalidates the daemon's entire KV cache on every
// single turn — measured: two turns of the same session reusing 0% of a
// 20k-token prefix, with no speed difference from a cold request, until this
// was excluded for 'ollama'.
const ANTHROPIC_MODEL_API_PROVIDERS = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
])

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 *
 * Includes a `cch=00000` placeholder that is replaced with a computed
 * xxHash64-based integrity hash before the request is sent. The fetch
 * wrapper in client.ts handles the replacement. The server verifies
 * this token to gate features like fast mode.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }
  if (!ANTHROPIC_MODEL_API_PROVIDERS.has(getAPIProvider())) {
    return ''
  }

  const version = `${ANTHROPIC_COMPAT_CLAUDE_CODE_VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  const cch = ' cch=00000;'
  // cc_workload: turn-scoped hint so the API can route e.g. cron-initiated
  // requests to a lower QoS pool. Absent = interactive default. Safe re:
  // fingerprint (a parameter here; callers compute it via `computeFingerprint`
  // in utils/fingerprint.ts, from FINGERPRINT_SALT + msg chars + version only)
  // and cch attestation (placeholder overwritten in serialized body bytes
  // after this string is built). Server _parse_cc_header tolerates unknown
  // extra fields so old API deploys silently ignore this.
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
