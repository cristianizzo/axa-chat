/**
 * Codex configuration: the single source of truth for everything specific to
 * running against ChatGPT's Codex backend — models, limits, endpoints, OAuth.
 *
 * Deliberately dependency-free, and it must stay that way. Callers range from
 * the `/model` picker to the networking layer to cost tracking, so an import
 * here would drag the fetch adapter's transitive dependencies into the picker
 * just to list model names.
 */

// ── Models ──────────────────────────────────────────────────────────

/**
 * Reasoning efforts the Codex backend accepts, weakest first. Our own `/effort`
 * vocabulary is narrower (low/medium/high/max — see EFFORT_LEVELS in
 * utils/effort.ts); {@link resolveCodexEffort} bridges the two.
 */
export const CODEX_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const

export type CodexReasoningEffort = (typeof CODEX_EFFORTS)[number]

/**
 * Single source of truth for the `/model` picker (see getCodexModelOptions in
 * modelOptions.ts). Adding an entry here surfaces it in the picker.
 *
 * Every field is transcribed from OpenAI's own catalog — `models.json` in
 * codex-rs/models-manager — restricted to entries whose `visibility` is `list`
 * and whose `available_in_plans` includes `plus`/`pro`. That restriction is the
 * whole point: the ChatGPT-subscription backend serves a *different, smaller*
 * set of models than the metered platform API, and requesting one it does not
 * serve fails the turn outright with
 *   "The '<id>' model is not supported when using Codex with a ChatGPT account."
 * So do not add an ID here from an OpenAI announcement or the platform API docs
 * without first confirming that catalog lists it for ChatGPT plans.
 *
 * `efforts` is each model's `supported_reasoning_levels`. These genuinely differ
 * per model, so it cannot be hoisted into a shared constant.
 *
 * Not exhaustive: any other `gpt-*` ID the user types is passed through to the
 * backend untouched (see mapClaudeModelToCodex), so a newly launched model works
 * without a code change — at the cost of no label and no effort clamping.
 */
export const CODEX_MODELS = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description:
      'Frontier model for complex coding, research, and real-world work.',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    description: 'Optimized for professional work and long-running agents.',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
] as const satisfies readonly {
  id: string
  label: string
  description: string
  efforts: readonly CodexReasoningEffort[]
}[]

/** The ID of any model listed above. */
export type CodexModelId = (typeof CODEX_MODELS)[number]['id']

/**
 * Codex's own catalog ranks `terra` second behind `sol`, describing it as the
 * balanced everyday model — the role Sonnet plays as our default. Defaulting to
 * the balanced tier rather than the most expensive one matches both.
 */
export const DEFAULT_CODEX_MODEL: CodexModelId = 'gpt-5.6-terra'

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
  opus: 'gpt-5.6-sol',
  sonnet: DEFAULT_CODEX_MODEL,
  haiku: 'gpt-5.6-luna',
} as const satisfies Record<string, CodexModelId>

// ── Limits ──────────────────────────────────────────────────────────

/**
 * Input-token context window for Codex models, per OpenAI's own model catalog
 * (codex-rs/models-manager/models.json). Every model listed above reports the
 * same value, so this is a constant rather than a per-model field.
 *
 * Input-only: the API docs quote a *total* of 400k, which is this plus 128k of
 * output. Do not conflate the two.
 *
 * Note this is the subscription figure, which has been lower than the metered
 * platform API's for past model generations. Take the catalog's number, not the
 * one in a platform API announcement.
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

// ── Endpoint ────────────────────────────────────────────────────────

/** The Responses API endpoint the fetch adapter POSTs translated requests to. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses'

// ── OAuth ───────────────────────────────────────────────────────────
//
// The Codex OAuth flow runs against OpenAI's own auth server and is completely
// separate from Anthropic's. Values originate from the @mariozechner/pi-ai
// package used by the openclaw project.

/** The registered OAuth client ID for Codex CLI tools. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** OpenAI's authorization endpoint. */
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'

/** OpenAI's token exchange / refresh endpoint. */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/**
 * The redirect URI registered for the Codex OAuth app. OpenAI requires a fixed
 * port (1455), unlike Anthropic which uses OS-assigned ports.
 */
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback'

/** Space-separated OAuth scopes requested from OpenAI. */
export const CODEX_SCOPES = 'openid profile email offline_access'

/**
 * JWT claim namespace where OpenAI places the chatgpt_account_id, i.e.
 * `payload['https://api.openai.com/auth'].chatgpt_account_id`.
 */
export const CODEX_JWT_AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * Provider identifier used in config storage to distinguish Codex credentials
 * from Anthropic credentials.
 */
export const CODEX_PROVIDER_ID = 'openai-codex' as const

// ── Predicates ──────────────────────────────────────────────────────

/**
 * True for any model that will be routed to the Codex backend.
 *
 * Broader than a CODEX_MODELS lookup on purpose: `mapClaudeModelToCodex`
 * forwards any other `gpt-*` ID untouched, so capability checks must agree
 * with that rather than only recognising the listed models.
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
 * Longest ID first, so a prefix never shadows a more specific model. No current
 * pair collides, but a bare 'gpt-5.6' alongside 'gpt-5.6-sol' would, and the
 * retired 'gpt-5.4'/'gpt-5.4-mini' pair did — matching in list order resolved
 * the mini model to the flagship. Sorting costs nothing and stops that class of
 * bug returning with the next model launch.
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

/**
 * Every listed model supports at least these, so they are the safe assumption
 * for an unlisted passthrough ID whose ladder we cannot know.
 */
const CODEX_BASE_EFFORTS: readonly CodexReasoningEffort[] = [
  'low',
  'medium',
  'high',
]

/**
 * Translates one of our `/effort` levels into a reasoning effort the given model
 * actually accepts.
 *
 * Necessary because the ladders differ per model: `gpt-5.5` and `gpt-5.2` stop
 * at `xhigh` while the 5.6 family goes further, and sending a level a model does
 * not list fails the whole turn. Our vocabulary tops out at 'max', which means
 * "as much as this model offers" rather than the literal string 'max'.
 *
 * @param model - The Codex model the request will be sent to
 * @param effort - One of our EFFORT_LEVELS ('low' | 'medium' | 'high' | 'max')
 * @returns An effort the model accepts, or null to let the backend default
 */
export function resolveCodexEffort(
  model: string,
  effort: string,
): CodexReasoningEffort | null {
  const id = findCodexModelId(model)
  const ladder: readonly CodexReasoningEffort[] =
    CODEX_MODELS.find(entry => entry.id === id)?.efforts ?? CODEX_BASE_EFFORTS

  if (effort === 'max') {
    // 'ultra' is deliberately excluded. The catalog describes it as "maximum
    // reasoning with automatic task delegation" — a behavioural change that
    // spawns sub-agents, not simply more thinking. Our 'max' asks for depth, so
    // opting a user into delegation because they turned effort up would be a
    // surprise, and one they cannot express the alternative of.
    const byDepth = ladder.filter(level => level !== 'ultra')
    return byDepth[byDepth.length - 1] ?? null
  }

  return ladder.includes(effort as CodexReasoningEffort)
    ? (effort as CodexReasoningEffort)
    : null
}
