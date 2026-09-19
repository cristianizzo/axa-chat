/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Reports whether this process has assets embedded by `bun build --compile`.
 *
 * Despite the name, this does NOT identify a compiled binary. Bun.embeddedFiles
 * is populated only by `import … with { type: "file" }`; there is no such import
 * anywhere in this tree, so the array is empty and this returns false for every
 * binary this repo builds — verified against a compiled binary, not assumed.
 *
 * Do not use it to decide "am I a compiled executable". process.execPath is the
 * real executable in both a compiled binary and a script run; see the notes
 * above getTeammateCommand() in src/utils/swarm/spawnUtils.ts for the way this
 * has already gone wrong once.
 */
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}

/**
 * Prefixes of Bun's virtual filesystem root, where the entry module of a
 * `bun build --compile` executable lives.
 *
 * `/$bunfs/` is measured (see isCompiledBinary). The Windows spelling is taken
 * from Bun's own documentation and is NOT measured here — this repo has no
 * Windows machine to measure it on. It is included because getting it wrong
 * fails in the safe direction: a Windows binary that is not recognised as
 * compiled behaves exactly as every build did before this function existed.
 */
const BUN_VFS_ROOT_PREFIXES = ['/$bunfs/', 'B:\\~BUN\\', '/~BUN/'] as const

/**
 * Whether this process is a `bun build --compile` standalone executable.
 *
 * This is the predicate `isInBundledMode()` above reads like and is not. Use
 * this one to answer "am I a compiled binary"; use that one only to answer
 * "were assets embedded", which in this tree is always no.
 *
 * Measured on Bun 1.3.11 / macOS arm64 with a purpose-built probe, not
 * inferred:
 *
 * | | compiled binary | `bun run entry.ts` |
 * |---|---|---|
 * | `Bun.main` | `/$bunfs/root/probe` | `/private/tmp/…/probe.ts` |
 * | `process.argv[1]` | `/$bunfs/root/probe` | `/private/tmp/…/probe.ts` |
 * | `process.execPath` | `/private/tmp/…/probe` | `…/bun/1.3.11/bin/bun` |
 * | `Bun.embeddedFiles.length` | **0** | **0** |
 *
 * The last row is why `isInBundledMode()` cannot answer this question, and the
 * reason it is restated as a measurement here rather than left as a comment
 * cross-reference: the two disagree on exactly the case that matters.
 *
 * `Bun.main` rather than `process.argv[1]`: argv can be rewritten by a launcher
 * and is optional in the type, while `Bun.main` is the runtime's own record of
 * the entry module. Both were measured identical above.
 */
export function isCompiledBinary(): boolean {
  if (typeof Bun === 'undefined') return false
  const entry = Bun.main
  if (typeof entry !== 'string' || entry === '') return false
  return BUN_VFS_ROOT_PREFIXES.some(prefix => entry.startsWith(prefix))
}
