/**
 * Kimi (Moonshot AI) configuration.
 *
 * Deliberately dependency-free, like config/codex.ts, config/ollama.ts and
 * config/deepseek.ts — it is imported by the auth-provider registry, the
 * networking layer and `/switch-account`, so it must not drag runtime
 * dependencies into those graphs.
 *
 * Unlike DeepSeek, Moonshot publishes an Anthropic-shaped endpoint, so the SDK
 * client talks to it directly with a base URL and a key. There is no fetch
 * adapter and no request translation. The cost of that convenience is that
 * anything the shim does not implement has to be turned off here rather than
 * quietly rewritten on the way out.
 */

/** Provider identifier used in config storage to distinguish Kimi credentials. */
export const KIMI_PROVIDER_ID = 'kimi' as const

/**
 * Moonshot's Anthropic-compatible base URL.
 *
 * Note the sibling `/v1` endpoint is the OpenAI-compatible one. Both serve the
 * same models under the same IDs; only the request shape differs, and this
 * fork wants the Anthropic shape.
 */
export const KIMI_BASE_URL = 'https://api.moonshot.ai/anthropic'

/**
 * Models available through Moonshot's API.
 *
 * This is the full set: `GET /v1/models` returns exactly these four IDs. The
 * `kimi-k2.5` and `moonshot-v1` series it used to serve are already gone ahead
 * of their 2026-08-31 retirement, so there is nothing else to list.
 *
 * Adding an entry here surfaces it in the `/model` picker for Kimi accounts.
 * Retired IDs belong in {@link KIMI_LEGACY_MODEL_ID_PREFIXES} instead, which
 * recognises them as ours without offering or requesting them.
 */
export const KIMI_MODELS = [
  {
    // Plain `kimi-k3`, verified against GET /v1/models — that endpoint lists
    // exactly the four IDs below and nothing else. Moonshot's Claude Code guide
    // shows ANTHROPIC_MODEL="kimi-k3[1m]", but the Anthropic endpoint 404s on
    // it ("Not found the model kimi-k3[1m] or Permission denied"), so the
    // suffix is documentation-only and must not reach the wire. Keeping it out
    // also keeps has1mContext() from adding `context-1m-2025-08-07`, an
    // Anthropic beta header this endpoint has no use for.
    id: 'kimi-k3',
    label: 'Kimi K3',
    description:
      'Flagship 2.8T mixture-of-experts model, 1M context. Thinking is always on.',
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    description: 'Cheaper coding-tuned model — roughly a third of K3 per token.',
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    label: 'Kimi K2.7 Code (high speed)',
    description: 'The K2.7 coding model tuned for latency over depth.',
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    description: 'Previous-generation general model, lowest cost of the four.',
  },
] as const satisfies readonly { id: string; label: string; description: string }[]

export type KimiModelId = (typeof KIMI_MODELS)[number]['id']

/**
 * Retired Moonshot model families — IDs that were ours, but that the API has
 * stopped serving.
 *
 * Wired to the catalog's `wasRetiredModel`, never to `acceptsModel`: unlike
 * DeepSeek's legacy IDs, which the API still serves as aliases, these 404. The
 * only thing that needs them is attribution. `utils/foreignSignatures.ts` reads
 * "no catalog claims this model" as "another account signed these thinking
 * blocks" and strips them, so without this list a Kimi session that recorded a
 * retired ID would silently throw away its own extended thinking on every turn.
 *
 * Prefixes rather than DeepSeek's exact IDs because both are families with
 * per-window variants (`moonshot-v1-8k` / `-32k` / `-128k`), and enumerating
 * them would mean guessing at IDs no endpoint reports any more. No current ID
 * collides — `kimi-k2.6` and `kimi-k2.7-*` do not start with `kimi-k2.5` — and
 * an over-claim could only ever catch another Moonshot ID, which is the right
 * owner regardless.
 */
export const KIMI_LEGACY_MODEL_ID_PREFIXES = [
  'kimi-k2.5',
  'moonshot-v1',
] as const satisfies readonly string[]

/** The model used when an account is first set up or no preference is stored. */
export const DEFAULT_KIMI_MODEL: KimiModelId = 'kimi-k3'

/**
 * What Kimi serves in place of Haiku for background work.
 *
 * The high-speed coding model rather than K3, on the same reasoning Anthropic
 * accounts use Haiku here: session titles, away summaries and WebFetch
 * extraction are one-shot jobs where latency and price matter and depth does
 * not. K3 additionally reasons by default, which such a job would pay for and
 * then discard unread.
 */
export const KIMI_SMALL_FAST_MODEL: KimiModelId = 'kimi-k2.7-code-highspeed'

// ── Limits ──────────────────────────────────────────────────────────

/**
 * Input-token context window.
 *
 * Input-only, matching how Codex is configured here: Moonshot quotes a total of
 * 1,048,576 for K3, and `max_completion_tokens` is drawn from the same budget —
 * the API rejects a request whose input plus max output exceeds the window. So
 * the room actually available for input is the total minus the output default
 * below. Do not restate the headline 1M figure here.
 */
export const KIMI_CONTEXT_WINDOW = 1_048_576 - 131_072

/**
 * Output-token limits.
 *
 * 131,072 is Moonshot's own documented default for K3. The API will accept a
 * `max_completion_tokens` as high as the whole context window, but raising the
 * ceiling only reserves budget out of the input side for output no turn
 * produces, so the upper limit is held at the default.
 */
export const KIMI_MAX_OUTPUT_TOKENS = {
  default: 131_072,
  upperLimit: 131_072,
} as const

/**
 * Requests Moonshot will process at once.
 *
 * One, on the tiers a new account lands in — the same tiers that allow 3
 * requests per minute. The number rises with spend, and an account that has
 * moved up can say so with CLAUDE_CODE_MAX_CONCURRENT_REQUESTS rather than
 * being held at the entry-tier figure. Nothing in the API reports the current
 * tier, so it cannot be discovered at runtime.
 */
export const KIMI_MAX_CONCURRENT_REQUESTS = 1
