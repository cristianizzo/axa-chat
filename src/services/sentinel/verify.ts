import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'

export type VerifyResult = {
  ok: boolean
  /**
   * Normalized diagnostic lines, deduplicated. Comparable across runs — see
   * `normalizeDiagnostic` for what is deliberately erased to make that true.
   */
  failures: string[]
  /**
   * The command failed but `failures` is not a usable account of why, so no
   * conclusion may be drawn from comparing it against another run.
   *
   * Two ways this happens, and both are dangerous to treat as data. The
   * command may not have run at all — a typo'd script exits 127 with nothing
   * on stdout, and calling that "zero failures" would establish an empty
   * baseline and then blame the user for every pre-existing error in the repo.
   * Or it produced more diagnostics than `MAX_FAILURES`, in which case the list
   * is an arbitrary prefix, and which entries survive shifts between runs.
   */
  inconclusive: boolean
}

/** Long enough for a cold `tsc` on a large project, short enough to not hang a session. */
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000
/** Beyond this the run is almost certainly a config mistake, not a regression. */
const MAX_FAILURES = 50

/**
 * Run the project's verify command and normalize whatever it printed.
 *
 * The command is a shell string straight from the user's own project config,
 * and running it is the entire point of the feature — this is the same trust
 * level as a `scripts` entry in package.json, not untrusted input.
 *
 * Exit code alone decides pass/fail. Parsing output to second-guess a zero
 * exit would break the contract that makes this work with any tool.
 */
export async function runVerify(
  command: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<VerifyResult> {
  const result = await execFileNoThrowWithCwd(command, [], {
    cwd,
    shell: true,
    timeout: VERIFY_TIMEOUT_MS,
    preserveOutputOnError: true,
    abortSignal,
    maxBuffer: 10_000_000,
  })

  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code === 0) {
    return { ok: true, failures: [], inconclusive: false }
  }

  const seen = new Set<string>()
  let truncated = false
  for (const line of output.split('\n')) {
    const normalized = normalizeDiagnostic(line, cwd)
    if (normalized) seen.add(normalized)
    if (seen.size >= MAX_FAILURES) {
      truncated = true
      break
    }
  }

  return {
    ok: false,
    failures: [...seen],
    inconclusive: truncated || seen.size === 0,
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
/** `(12,34)` as tsc writes it, and `:12:34` as eslint and friends do. */
const TSC_POSITION = /\((\d+),(\d+)\)/g
const COLON_POSITION = /:\d+:\d+/g

/**
 * Reduce one output line to a stable key, or null if it carries no diagnostic.
 *
 * Line and column numbers are erased on purpose. They are the whole difficulty
 * in comparing two runs: inserting a single line at the top of a file shifts
 * every diagnostic below it, and a naive comparison would then report every
 * pre-existing error in that file as newly introduced. What survives — the
 * file, the error code, the message — is what actually identifies a problem.
 *
 * The cost is real but small: two instances of the identical error in the same
 * file collapse to one key, so fixing one of them looks like fixing both. That
 * is the acceptable direction, since the sentinel errs toward staying quiet.
 */
export function normalizeDiagnostic(line: string, cwd: string): string | null {
  let text = line.replace(ANSI, '').trim()
  if (!text) return null

  // Absolute paths differ between the main tree and a worktree copy, which
  // would otherwise make every diagnostic look new the moment it is re-run
  // somewhere else. Both separators, because on Windows `cwd` arrives with
  // backslashes and tools print paths the same way — stripping only the POSIX
  // form there would leave the absolute prefix in every key.
  text = text.split(`${cwd}/`).join('').split(`${cwd}\\`).join('')

  text = text.replace(TSC_POSITION, '').replace(COLON_POSITION, '')

  // Progress chatter and summary counts move on their own and would produce
  // endless phantom diffs ("Found 7 errors" → "Found 6 errors").
  if (/^(found \d+ error|\d+ (problems?|errors?|warnings?)\b)/i.test(text)) {
    return null
  }

  // A diagnostic names a severity somewhere. Without this the digest fills
  // with banner lines, stack frames and blank separators.
  if (!/\b(error|warning|fail(ed|ure)?)\b/i.test(text)) return null

  return text.replace(/\s+/g, ' ')
}
