import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isCompiledBinary, isInBundledMode } from './bundledMode.js'

/**
 * `isCompiledBinary()` cannot be unit-tested by stubbing, because the thing it
 * reads — `Bun.main` — is the runtime's own record of the entry module and is
 * not writable. Mocking it would only prove that the mock works.
 *
 * So the compiled case is tested by actually compiling: a probe that imports
 * the real function from this file, built with the same `bun build --compile`
 * the release uses, then executed. That is the only instrument that can tell
 * the two predicates apart, and telling them apart is the entire point of the
 * function.
 */

test('isCompiledBinary() is false when running from source', () => {
  // This test process is `bun test`, i.e. an interpreter running a real file.
  expect(isCompiledBinary()).toBe(false)
})

test('isInBundledMode() is false from source too — it is not this predicate', () => {
  // Restated as a test rather than a comment: the two agree here and disagree
  // in the compiled probe below, which is what makes the distinction real.
  expect(isInBundledMode()).toBe(false)
})

test('isCompiledBinary() is true inside a bun build --compile executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axa-bundledmode-'))
  try {
    const probeSource = join(dir, 'probe.ts')
    const probeBinary = join(dir, 'probe')
    writeFileSync(
      probeSource,
      [
        `import { isCompiledBinary, isInBundledMode } from ${JSON.stringify(import.meta.dir + '/bundledMode.ts')}`,
        'console.log(JSON.stringify({',
        '  compiled: isCompiledBinary(),',
        '  bundled: isInBundledMode(),',
        '  entry: Bun.main,',
        '}))',
        '',
      ].join('\n'),
    )

    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        'build',
        probeSource,
        '--compile',
        '--target',
        'bun',
        '--outfile',
        probeBinary,
      ],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(
      build.exitCode,
      `probe build failed:\n${new TextDecoder().decode(build.stderr)}`,
    ).toBe(0)

    // Run from a directory that is not the repo and not the binary's own, so a
    // predicate that accidentally keyed off cwd would be caught here.
    const run = Bun.spawnSync({
      cmd: [probeBinary],
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(
      run.exitCode,
      `probe run failed:\n${new TextDecoder().decode(run.stderr)}`,
    ).toBe(0)

    const result = JSON.parse(new TextDecoder().decode(run.stdout)) as {
      compiled: boolean
      bundled: boolean
      entry: string
    }

    expect(result.compiled).toBe(true)
    // The regression this whole change exists for: the old predicate stays
    // false in the very case it was being asked about.
    expect(result.bundled).toBe(false)
    expect(result.entry.startsWith('/$bunfs/')).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
