import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The gate is a runtime kill switch, so a value arriving after startup has to
 * be able to turn customization back on. The loaders memoise whatever they
 * returned and initializeKeybindingWatcher() is called once, so without an
 * explicit retry a gated-off result is permanent for the process.
 */

let gate: boolean | undefined = false
let fireRefresh: (() => void) | null = null

mock.module('../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (_feature: string, fallback: unknown) =>
    gate === undefined ? fallback : gate,
  onGrowthBookRefresh: (listener: () => void) => {
    fireRefresh = listener
    return () => {
      fireRefresh = null
    }
  },
}))

const TEST_ACTION = 'command:gate-retry-fixture'

let configDir: string
let previousConfigDir: string | undefined

const mod = await import('./loadUserBindings.js')

const hasFixtureBinding = () =>
  mod.loadKeybindingsSync().some(b => b.action === TEST_ACTION)

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'keybindings-gate-'))
  writeFileSync(
    join(configDir, 'keybindings.json'),
    JSON.stringify({
      bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+9': TEST_ACTION } }],
    }),
  )
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  gate = false
})

afterEach(() => {
  mod.resetKeybindingLoaderForTesting()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

test('a gated-off result is dropped when the gate later turns on', async () => {
  await mod.initializeKeybindingWatcher()
  expect(fireRefresh).not.toBeNull()
  expect(hasFixtureBinding()).toBe(false)

  gate = true
  fireRefresh!()
  await new Promise(r => setTimeout(r, 300))

  expect(hasFixtureBinding()).toBe(true)
})

test('a refresh that leaves the gate off changes nothing', async () => {
  await mod.initializeKeybindingWatcher()
  fireRefresh!()
  await new Promise(r => setTimeout(r, 100))

  expect(hasFixtureBinding()).toBe(false)
})

test('an absent gate enables customization', async () => {
  gate = undefined
  await mod.initializeKeybindingWatcher()

  expect(hasFixtureBinding()).toBe(true)
})
