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
