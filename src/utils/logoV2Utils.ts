import { getDirectConnectServerUrl, getSessionId } from '../bootstrap/state.js'
import {
  ALL_PROVIDERS,
  ANTHROPIC_PROVIDER_ID,
  type AuthProviderId,
} from '../config/providers/index.js'
import { CODEX_PROVIDER_ID } from '../config/codex.js'
import { DEEPSEEK_PROVIDER_ID } from '../config/deepseek.js'
import { KIMI_PROVIDER_ID } from '../config/kimi.js'
import { OLLAMA_PROVIDER_ID } from '../config/ollama.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { LogOption } from '../types/logs.js'
import {
  getActiveAuthProvider,
  hasCredentialsForAuthProvider,
} from './activeAuthProvider.js'
import { getSubscriptionName, isClaudeAISubscriber } from './auth.js'
import { getGlobalConfig } from './config.js'
import { getCwd } from './cwd.js'
import { getDisplayPath } from './file.js'
import {
  truncate,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from './format.js'
import { isActiveAccountServingRequests } from './model/providers.js'
import {
  getRecentReleaseNotes,
  getStoredChangelogFromMemory,
} from './releaseNotes.js'
import { gt } from './semver.js'
import { loadMessageLogs } from './sessionStorage.js'
import { getInitialSettings } from './settings/settings.js'

// Layout constants
const MAX_LEFT_WIDTH = 50
const MAX_USERNAME_LENGTH = 20
const BORDER_PADDING = 4
const DIVIDER_WIDTH = 1
const CONTENT_PADDING = 2

export type LayoutMode = 'horizontal' | 'compact'

export type LayoutDimensions = {
  leftWidth: number
  rightWidth: number
  totalWidth: number
}

/**
 * Determines the layout mode based on terminal width
 */
export function getLayoutMode(columns: number): LayoutMode {
  if (columns >= 70) return 'horizontal'
  return 'compact'
}

/**
 * Calculates layout dimensions for the LogoV2 component
 */
export function calculateLayoutDimensions(
  columns: number,
  layoutMode: LayoutMode,
  optimalLeftWidth: number,
): LayoutDimensions {
  if (layoutMode === 'horizontal') {
    const leftWidth = optimalLeftWidth
    const usedSpace =
      BORDER_PADDING + CONTENT_PADDING + DIVIDER_WIDTH + leftWidth
    const availableForRight = columns - usedSpace

    let rightWidth = Math.max(30, availableForRight)
    const totalWidth = Math.min(
      leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING,
      columns - BORDER_PADDING,
    )

    // Recalculate right width if we had to cap the total
    if (totalWidth < leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING) {
      rightWidth = totalWidth - leftWidth - DIVIDER_WIDTH - CONTENT_PADDING
    }

    return { leftWidth, rightWidth, totalWidth }
  }

  // Vertical mode
  const totalWidth = Math.min(columns - BORDER_PADDING, MAX_LEFT_WIDTH + 20)
  return {
    leftWidth: totalWidth,
    rightWidth: totalWidth,
    totalWidth,
  }
}

/**
 * Calculates optimal left panel width based on content
 *
 * @param lines - The rendered lines of the left panel, in any order. Variadic
 *   because the panel's line count is not fixed: the provider lights line is
 *   only there when there is more than one account to distinguish.
 */
export function calculateOptimalLeftWidth(...lines: string[]): number {
  const contentWidth = Math.max(
    ...lines.map(stringWidth),
    20, // Minimum for clawd art
  )
  return Math.min(contentWidth + 4, MAX_LEFT_WIDTH) // +4 for padding
}

/**
 * Formats the welcome message based on username
 */
export function formatWelcomeMessage(username: string | null): string {
  if (!username || username.length > MAX_USERNAME_LENGTH) {
    return 'Welcome back!'
  }
  return `Welcome back ${username}!`
}

/**
 * Truncates a path in the middle if it's too long.
 * Width-aware: uses stringWidth() for correct CJK/emoji measurement.
 */
export function truncatePath(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path

  const separator = '/'
  const ellipsis = '…'
  const ellipsisWidth = 1 // '…' is always 1 column
  const separatorWidth = 1

  const parts = path.split(separator)
  const first = parts[0] || ''
  const last = parts[parts.length - 1] || ''
  const firstWidth = stringWidth(first)
  const lastWidth = stringWidth(last)

  // Only one part, so show as much of it as we can
  if (parts.length === 1) {
    return truncateToWidth(path, maxLength)
  }

  // We don't have enough space to show the last part, so truncate it
  // But since firstPart is empty (unix) we don't want the extra ellipsis
  if (first === '' && ellipsisWidth + separatorWidth + lastWidth >= maxLength) {
    return `${separator}${truncateToWidth(last, Math.max(1, maxLength - separatorWidth))}`
  }

  // We have a first part so let's show the ellipsis and truncate last part
  if (
    first !== '' &&
    ellipsisWidth * 2 + separatorWidth + lastWidth >= maxLength
  ) {
    return `${ellipsis}${separator}${truncateToWidth(last, Math.max(1, maxLength - ellipsisWidth - separatorWidth))}`
  }

  // Truncate first and leave last
  if (parts.length === 2) {
    const availableForFirst =
      maxLength - ellipsisWidth - separatorWidth - lastWidth
    return `${truncateToWidthNoEllipsis(first, availableForFirst)}${ellipsis}${separator}${last}`
  }

  // Now we start removing middle parts

  let available =
    maxLength - firstWidth - lastWidth - ellipsisWidth - 2 * separatorWidth

  // Just the first and last are too long, so truncate first
  if (available <= 0) {
    const availableForFirst = Math.max(
      0,
      maxLength - lastWidth - ellipsisWidth - 2 * separatorWidth,
    )
    const truncatedFirst = truncateToWidthNoEllipsis(first, availableForFirst)
    return `${truncatedFirst}${separator}${ellipsis}${separator}${last}`
  }

  // Try to keep as many middle parts as possible
  const middleParts = []
  for (let i = parts.length - 2; i > 0; i--) {
    const part = parts[i]
    if (part && stringWidth(part) + separatorWidth <= available) {
      middleParts.unshift(part)
      available -= stringWidth(part) + separatorWidth
    } else {
      break
    }
  }

  if (middleParts.length === 0) {
    return `${first}${separator}${ellipsis}${separator}${last}`
  }

  return `${first}${separator}${ellipsis}${separator}${middleParts.join(separator)}${separator}${last}`
}

// Simple cache for preloaded activity
let cachedActivity: LogOption[] = []
let cachePromise: Promise<LogOption[]> | null = null

/**
 * Preloads recent conversations for display in Logo v2
 */
export async function getRecentActivity(): Promise<LogOption[]> {
  // Return existing promise if already loading
  if (cachePromise) {
    return cachePromise
  }

  const currentSessionId = getSessionId()
  cachePromise = loadMessageLogs(10)
    .then(logs => {
      cachedActivity = logs
        .filter(log => {
          if (log.isSidechain) return false
          if (log.sessionId === currentSessionId) return false
          if (log.summary?.includes('I apologize')) return false

          // Filter out sessions where both summary and firstPrompt are "No prompt" or missing
          const hasSummary = log.summary && log.summary !== 'No prompt'
          const hasFirstPrompt =
            log.firstPrompt && log.firstPrompt !== 'No prompt'
          return hasSummary || hasFirstPrompt
        })
        .slice(0, 3)
      return cachedActivity
    })
    .catch(() => {
      cachedActivity = []
      return cachedActivity
    })

  return cachePromise
}

/**
 * Gets cached activity synchronously
 */
export function getRecentActivitySync(): LogOption[] {
  return cachedActivity
}

/**
 * Formats release notes for display, with smart truncation
 */
export function formatReleaseNoteForDisplay(
  note: string,
  maxWidth: number,
): string {
  // Simply truncate at the max width, same as Recent Activity descriptions
  return truncate(note, maxWidth)
}

/**
 * How the banner describes who is paying for this session.
 *
 * Keyed on the active account rather than on credential predicates. Those
 * predicates each inspect one provider's stored credentials, which outlive a
 * `/switch-account`, so asking them in order meant whichever provider was
 * checked first won: a Kimi session still holding Anthropic tokens was labelled
 * "Claude Max" while Moonshot served every request. Codex had already been
 * special-cased to the front of that chain for exactly this reason, which fixed
 * Codex and left every provider added afterwards broken.
 *
 * The switch is deliberately exhaustive with no `default`, so adding a provider
 * to the registry without giving it a label is a compile error rather than a
 * silent fallback to Anthropic's.
 */
function getBillingTypeLabel(): string {
  // CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY beat the account in getAPIProvider()
  // and again in getAnthropicClient(), so the account is not who gets billed and
  // its label would be a lie — "Local Model" on a session billing every token to
  // Bedrock, say. All three are metered cloud backends, which is the one thing
  // they have in common and the only thing this line claims.
  if (!isActiveAccountServingRequests()) {
    return 'API Usage Billing'
  }

  const provider: AuthProviderId = getActiveAuthProvider()
  switch (provider) {
    case ANTHROPIC_PROVIDER_ID:
      // Still a predicate here, because "Anthropic account" covers both a
      // claude.ai subscription and a metered API key, and only the token
      // scopes distinguish them.
      return isClaudeAISubscriber() ? getSubscriptionName() : 'API Usage Billing'
    case CODEX_PROVIDER_ID:
      return 'ChatGPT Subscription'
    case OLLAMA_PROVIDER_ID:
      // Self-hosted: nothing is being billed, and saying "API Usage Billing"
      // implies otherwise.
      return 'Local Model'
    case DEEPSEEK_PROVIDER_ID:
      return 'DeepSeek API Usage'
    case KIMI_PROVIDER_ID:
      return 'Moonshot API Usage'
  }
}

/** The glyph beside a provider that has stored credentials, and one that has not. */
export const PROVIDER_CONNECTED_GLYPH = '●'
export const PROVIDER_DISCONNECTED_GLYPH = '○'

/** One provider's entry in the banner's connected-accounts line. */
export type ProviderStatusLight = {
  id: AuthProviderId
  label: string
  /** Stored credentials exist for it. */
  connected: boolean
  /** It is the account serving this session's requests. */
  active: boolean
}

/**
 * The connected-accounts line for the banner, or an empty list when there is
 * nothing to show.
 *
 * Credentials-only by design: `connected` means "a credential record is on this
 * machine", not "that credential still works". Probing each provider would mean
 * a network round trip per account on every startup, and the banner renders
 * before the first request — so an expired key or a stopped Ollama daemon still
 * shows green. The first request reports the real failure, which is where a
 * user can act on it.
 *
 * Empty below two connected accounts: a single-provider install would otherwise
 * get a row of dim glyphs for providers it has never heard of, which reads as a
 * setup checklist rather than as status. With one account there is nothing to
 * disambiguate — the model and billing line underneath already names it.
 *
 * Also empty when even the connected accounts alone do not fit. The line must
 * be one row — it shares the banner with the activity feed — and it is a single
 * unit, so truncating it mid-list would be a claim about accounts rather than a
 * shortened one.
 *
 * @param availableWidth - Columns the line may occupy
 * @returns One entry per registered provider, minus any unconfigured ones that
 *   did not fit, or `[]` when there is nothing worth showing
 */
export function getProviderStatusLights(
  availableWidth: number,
): ProviderStatusLight[] {
  // Same guard the billing line opens with. CLAUDE_CODE_USE_BEDROCK/_VERTEX/
  // _FOUNDRY beat the account in getAPIProvider(), so no account is serving
  // this session and there is no `active` to emphasise. Showing the list with
  // every entry unemphasised would read as "none of your logins is working"
  // rather than "a cloud backend is configured", which is what the billing
  // line already says.
  if (!isActiveAccountServingRequests()) {
    return []
  }

  const active = getActiveAuthProvider()
  const lights = ALL_PROVIDERS.map(provider => ({
    id: provider.id,
    label: provider.shortLabel ?? provider.label,
    connected: hasCredentialsForAuthProvider(provider.id),
    active: provider.id === active,
  }))
  if (lights.filter(light => light.connected).length < 2) {
    return []
  }

  // Unconfigured providers are the discoverable part of the line, not the
  // informative part, so they are what gives way when the panel is narrow —
  // from the right, so the ones a user sees are stable as the terminal grows.
  const trimmed = [...lights]
  const fits = () =>
    stringWidth(formatProviderStatusLine(trimmed)) <= availableWidth
  for (let i = trimmed.length - 1; i >= 0 && !fits(); i--) {
    if (!trimmed[i]!.connected) {
      trimmed.splice(i, 1)
    }
  }
  return fits() ? trimmed : []
}

/**
 * The plain-text form of {@link getProviderStatusLights}, for width measurement.
 *
 * The rendered version splits this across nested `Text` nodes so the active
 * account can be emphasised, but its printed width is identical.
 *
 * @param lights - The lights to measure
 * @returns The line as it will appear, e.g. `Anthropic ● Codex ● Kimi ○`
 */
export function formatProviderStatusLine(
  lights: readonly ProviderStatusLight[],
): string {
  return lights
    .map(
      light =>
        `${light.label} ${light.connected ? PROVIDER_CONNECTED_GLYPH : PROVIDER_DISCONNECTED_GLYPH}`,
    )
    .join(' ')
}

/**
 * A memo key for a rendered lights line.
 *
 * {@link formatProviderStatusLine} is not usable as one: which entry is active
 * changes the emphasis without changing a character.
 *
 * @param lights - The lights being rendered
 * @returns A string that differs whenever the rendering would
 */
export function providerStatusKey(
  lights: readonly ProviderStatusLight[],
): string {
  return lights
    .map(light => `${light.id}:${light.connected}:${light.active}`)
    .join(',')
}

/**
 * Gets the common logo display data used by both LogoV2 and CondensedLogo
 */
export function getLogoDisplayData(): {
  version: string
  cwd: string
  billingType: string
  agentName: string | undefined
} {
  const version = process.env.DEMO_VERSION ?? MACRO.VERSION
  const serverUrl = getDirectConnectServerUrl()
  const displayPath = process.env.DEMO_VERSION
    ? '/code/claude'
    : getDisplayPath(getCwd())
  const cwd = serverUrl
    ? `${displayPath} in ${serverUrl.replace(/^https?:\/\//, '')}`
    : displayPath
  const billingType = getBillingTypeLabel()
  const agentName = getInitialSettings().agent

  return {
    version,
    cwd,
    billingType,
    agentName,
  }
}

/**
 * The organization to name on the banner's model line, if any.
 *
 * Empty for anything other than an Anthropic login: oauthAccount holds the
 * Anthropic organization, so a Codex session was being labelled with the org of
 * an account it was not using — "GPT-5.6-Terra · ChatGPT Subscription · <your
 * Anthropic org>".
 *
 * @returns The organization name, or undefined when it should not be shown
 */
export function getBannerOrganizationName(): string | undefined {
  if (process.env.IS_DEMO) {
    return undefined
  }
  if (getActiveAuthProvider() !== ANTHROPIC_PROVIDER_ID) {
    return undefined
  }
  return getGlobalConfig().oauthAccount?.organizationName
}

/**
 * Determines how to display model and billing information based on available width
 */
export function formatModelAndBilling(
  modelName: string,
  billingType: string,
  availableWidth: number,
): {
  shouldSplit: boolean
  truncatedModel: string
  truncatedBilling: string
} {
  const separator = ' · '
  const combinedWidth =
    stringWidth(modelName) + separator.length + stringWidth(billingType)
  const shouldSplit = combinedWidth > availableWidth

  if (shouldSplit) {
    return {
      shouldSplit: true,
      truncatedModel: truncate(modelName, availableWidth),
      truncatedBilling: truncate(billingType, availableWidth),
    }
  }

  return {
    shouldSplit: false,
    truncatedModel: truncate(
      modelName,
      Math.max(
        availableWidth - stringWidth(billingType) - separator.length,
        10,
      ),
    ),
    truncatedBilling: billingType,
  }
}

/**
 * Gets recent release notes for Logo v2 display
 * For ants, uses commits bundled at build time
 * For external users, uses public changelog
 */
export function getRecentReleaseNotesSync(
  maxItems: number,
  currentVersion: string = MACRO.VERSION,
  lastSeenVersion?: string | null,
): string[] {
  // For ants, use bundled changelog
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return commits.slice(0, maxItems)
    }
    return []
  }

  const changelog = getStoredChangelogFromMemory()
  if (!changelog) {
    return []
  }

  return getRecentReleaseNotes(currentVersion, lastSeenVersion, changelog).slice(
    0,
    maxItems,
  )
}
