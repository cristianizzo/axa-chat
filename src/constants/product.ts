/**
 * What this tool calls itself in the terminal.
 *
 * Only for text the user reads. Everything with a contract attached keeps its
 * upstream name: the `CLAUDE_CODE_*` environment variables, `CLAUDE.md`, model
 * ids, and the prompts sent to the model — renaming those breaks compatibility
 * or changes model behaviour. Statements about Anthropic ("Claude Max",
 * claude.ai, the Claude desktop app) also stay as they are, since they are true
 * and this fork does not replace them.
 *
 * The home config directory is the one exception: see CONFIG_DIR_NAME.
 */
export const PRODUCT_NAME = 'AXA Chat'

/**
 * The config directory name, used at both scopes: `~/.axa` per user, and
 * `<repo>/.axa` per project.
 *
 * Deliberately *not* `.claude`. axa owns its storage outright: it starts empty
 * on a fresh install and never reads or writes `~/.claude`, so an existing
 * Claude Code install keeps working untouched alongside it. Existing history is
 * pulled across only by an explicit, re-runnable `/import-conversations`.
 *
 * The project scope used to keep the upstream `.claude` name, on the grounds
 * that those files are shared with collaborators and read by other tools. That
 * traded one problem for a worse one: the two scopes disagreed, so where a
 * given piece of state landed depended on which code path wrote it, and a fork
 * that refuses to touch `~/.claude` was still writing another product's name
 * into every repo it was used on. One name at both scopes, and
 * `migrateProjectConfigDir` moves an existing `.claude/` across.
 *
 * `CLAUDE.md` at a repo root is not this directory and keeps its name — it is
 * read by the model and by other tools, and is a contract in the sense the
 * comment above describes.
 */
export const CONFIG_DIR_NAME = '.axa'

/**
 * The pre-rename project directory, and the memory filenames that went with it.
 *
 * Read in exactly one place: the startup check that offers to import a Claude
 * Code project into axa. Nothing else consults them — axa reads and writes its
 * own names only, so a project that declines the import is simply a project
 * axa has no instructions for, rather than one silently served by another
 * product's files.
 */
export const LEGACY_CONFIG_DIR_NAME = '.claude'
export const LEGACY_MEMORY_FILE_NAME = 'CLAUDE.md'
export const LEGACY_LOCAL_MEMORY_FILE_NAME = 'CLAUDE.local.md'

/**
 * The project instruction files axa reads and writes.
 *
 * `CLAUDE.md` is an upstream name for an upstream product. Keeping it would
 * mean this fork asking users to put a competitor's filename in their repo,
 * and would leave the tree half-renamed next to `.axa/`.
 */
export const MEMORY_FILE_NAME = 'AXA.md'
export const LOCAL_MEMORY_FILE_NAME = 'AXA.local.md'

/**
 * Base name of the macOS Keychain entry holding credentials.
 *
 * Must differ from Claude Code's `Claude Code` for the same reason
 * CONFIG_DIR_NAME differs from `.claude`, and here the consequence is sharper:
 * the service name only varies by config dir when CLAUDE_CONFIG_DIR is set
 * (see getMacOsKeychainStorageServiceName), so keeping the upstream base would
 * make both installs read and write one credential — and an OAuth refresh from
 * one rotates the token out from under the other, logging it out.
 *
 * Credentials come across through `/import-conversations`, which copies rather
 * than moves, leaving the Claude Code entry intact.
 */
export const KEYCHAIN_SERVICE_NAME = 'AXA Chat'

/**
 * The assistant's name in running prose — "Ask axa to …".
 *
 * Lowercase to match the binary. Note this is still Anthropic-shaped in one
 * respect: strings like "Claude is thinking" are wrong for a second reason
 * when the active provider is Codex, DeepSeek, Kimi or Ollama, and belong to
 * the provider-blind label work rather than here.
 */
export const ASSISTANT_NAME = 'axa'

/**
 * The command users type. `claude` stays as a second bin in package.json for
 * anything that already invokes it, but help text names this one.
 */
export const BINARY_NAME = 'axa'

export const PRODUCT_URL = 'https://claude.com/claude-code'

// Claude Code Remote session URLs
export const CLAUDE_AI_BASE_URL = 'https://claude.ai'
export const CLAUDE_AI_STAGING_BASE_URL = 'https://claude-ai.staging.ant.dev'
export const CLAUDE_AI_LOCAL_BASE_URL = 'http://localhost:4000'

/**
 * Determine if we're in a staging environment for remote sessions.
 * Checks session ID format and ingress URL.
 */
export function isRemoteSessionStaging(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_staging_') === true ||
    ingressUrl?.includes('staging') === true
  )
}

/**
 * Determine if we're in a local-dev environment for remote sessions.
 * Checks session ID format (e.g. `session_local_...`) and ingress URL.
 */
export function isRemoteSessionLocal(
  sessionId?: string,
  ingressUrl?: string,
): boolean {
  return (
    sessionId?.includes('_local_') === true ||
    ingressUrl?.includes('localhost') === true
  )
}

/**
 * Get the base URL for Claude AI based on environment.
 */
export function getClaudeAiBaseUrl(
  sessionId?: string,
  ingressUrl?: string,
): string {
  if (isRemoteSessionLocal(sessionId, ingressUrl)) {
    return CLAUDE_AI_LOCAL_BASE_URL
  }
  if (isRemoteSessionStaging(sessionId, ingressUrl)) {
    return CLAUDE_AI_STAGING_BASE_URL
  }
  return CLAUDE_AI_BASE_URL
}

/**
 * Get the full session URL for a remote session.
 *
 * The cse_→session_ translation is a temporary shim gated by
 * tengu_bridge_repl_v2_cse_shim_enabled (see isCseShimEnabled). Worker
 * endpoints (/v1/code/sessions/{id}/worker/*) want `cse_*` but the claude.ai
 * frontend currently routes on `session_*` (compat/convert.go:27 validates
 * TagSession). Same UUID body, different tag prefix. Once the server tags by
 * environment_kind and the frontend accepts `cse_*` directly, flip the gate
 * off. No-op for IDs already in `session_*` form. See toCompatSessionId in
 * src/bridge/sessionIdCompat.ts for the canonical helper (lazy-required here
 * to keep constants/ leaf-of-DAG at module-load time).
 */
export function getRemoteSessionUrl(
  sessionId: string,
  ingressUrl?: string,
): string {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { toCompatSessionId } =
    require('../bridge/sessionIdCompat.js') as typeof import('../bridge/sessionIdCompat.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const compatId = toCompatSessionId(sessionId)
  const baseUrl = getClaudeAiBaseUrl(compatId, ingressUrl)
  return `${baseUrl}/code/${compatId}`
}
