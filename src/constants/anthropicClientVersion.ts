/**
 * The Claude-Code-compatible version string this fork reports to Anthropic's
 * Messages API for client-version gating, e.g. `User-Agent: claude-cli/X.Y.Z`
 * (utils/http.ts getUserAgent) and the `cc_version=` field of the attribution
 * header (constants/system.ts getAttributionHeader).
 *
 * Deliberately NOT the same value as MACRO.VERSION: this fork's own version
 * (package.json, baked in at build time) tracks axa's release history, not
 * upstream Claude Code's. Anthropic's backend started rejecting requests
 * whose reported client version is below a minimum it enforces server-side
 * for gating newer models (seen 2026-09: 400 claude_code_version_too_old,
 * "version 2.1.251 or newer is required" when selecting Fable 5.1) — axa's
 * real version numbers happily satisfy that check, but reporting axa's own
 * low numbers as if they were the upstream Claude Code version fails it even
 * though nothing about this fork's actual model/tool support is behind.
 *
 * This must be bumped whenever Anthropic raises that server-side minimum
 * again (the error message states the current floor) — there is no way to
 * discover the new floor except hitting a 400 like this one, so treat any
 * future `claude_code_version_too_old` report as "bump this constant", not
 * as a bug in axa's own versioning.
 *
 * Do NOT use this for anything that is axa's own real version — --version
 * output, update-checking (gte()/lt() against the changelog), telemetry, and
 * MACRO.VERSION's other call sites must keep reporting the true axa version.
 *
 * Fingerprinting IS a consumer of this constant, not an exception to the rule
 * above: utils/fingerprint.ts computeFingerprint() and utils/sideQuery.ts
 * both hash this value rather than MACRO.VERSION, because the backend
 * validates the fingerprint against the version it was told in the
 * attribution header (cc_version, itself sourced from this constant) — not
 * against whatever version actually computed the hash. Hashing MACRO.VERSION
 * there would make the fingerprint mismatch the header on every request.
 *
 * Kept in its own dependency-free file (rather than constants/system.ts,
 * where it conceptually belongs) because constants/system.ts imports
 * services/analytics/growthbook.js, which imports utils/http.js — and
 * utils/http.js is one of this constant's two consumers. Importing it from
 * constants/system.ts would recreate the exact circular-dependency shape
 * constants/system.ts's own header says it was extracted to avoid.
 */
export const ANTHROPIC_COMPAT_CLAUDE_CODE_VERSION = '2.1.251'
