import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The gate is a runtime kill switch, so it has to be followed in both
 * directions after startup. The loaders memoise whatever they returned and
 * initializeKeybindingWatcher() is called once, so without an explicit
 * subscription the value observed at startup is permanent for the process.
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

let watchCalls = 0
let closeCalls = 0

mock.module('chokidar', () => {
  const watch = () => {
    watchCalls++
    return {
      on: () => {},
      close: async () => {
        closeCalls++
      },
    }
  }
  return { default: { watch }, watch }
})

const TEST_ACTION = 'command:gate-retry-fixture'
const KEYBINDING_GATE = 'tengu_keybinding_customization_release'

// saveGlobalConfig() only mutates an in-memory object under NODE_ENV=test, so
// this never touches the real ~/.claude/config.json.
const { saveGlobalConfig } = await import('../utils/config.js')

const setCachedGate = (value: boolean | undefined) =>
  saveGlobalConfig(config => ({
    ...config,
    cachedGrowthBookFeatures:
      value === undefined ? {} : { [KEYBINDING_GATE]: value },
  }))

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
  watchCalls = 0
  closeCalls = 0
  setCachedGate(undefined)
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

test('the kill switch drops custom bindings and closes the watcher', async () => {
  gate = true
  await mod.initializeKeybindingWatcher()
  expect(hasFixtureBinding()).toBe(true)
  expect(watchCalls).toBe(1)

  const emitted: string[][] = []
  mod.subscribeToKeybindingChanges(result =>
    emitted.push(result.bindings.map(b => b.action)),
  )

  gate = false
  fireRefresh!()
  await new Promise(r => setTimeout(r, 100))

  expect(hasFixtureBinding()).toBe(false)
  expect(closeCalls).toBe(1)
  // Subscribers have to hear about it: the UI keeps its own copy of the
  // bindings and would otherwise keep the custom ones on screen.
  expect(emitted.length).toBe(1)
  expect(emitted[0]).not.toContain(TEST_ACTION)
})

test('the gate can be turned back on after the kill switch', async () => {
  gate = true
  await mod.initializeKeybindingWatcher()

  gate = false
  fireRefresh!()
  await new Promise(r => setTimeout(r, 100))
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

test('concurrent initialization creates a single watcher', async () => {
  gate = true
  // `initialized` is only set once the directory stat resolves, so two
  // overlapping calls would otherwise both get past that check.
  await Promise.all([
    mod.initializeKeybindingWatcher(),
    mod.initializeKeybindingWatcher(),
  ])

  expect(watchCalls).toBe(1)
})

/**
 * The provider reads bindings synchronously at mount and only then calls
 * initializeKeybindingWatcher(), so the cache can already hold user bindings
 * by the time the gate is first consulted for the watcher. Nothing else
 * re-checks it: loadKeybindingsSync() returns the cache without looking at the
 * gate.
 */
test('initialization drops bindings cached before the gate went off', async () => {
  gate = true
  expect(hasFixtureBinding()).toBe(true)

  const emitted: string[][] = []
  mod.subscribeToKeybindingChanges(result =>
    emitted.push(result.bindings.map(b => b.action)),
  )

  gate = false
  await mod.initializeKeybindingWatcher()

  expect(hasFixtureBinding()).toBe(false)
  expect(emitted.length).toBe(1)
  expect(emitted[0]).not.toContain(TEST_ACTION)
})

test('a gate that flips off and on mid-init still ends up watching', async () => {
  gate = true
  const pending = mod.initializeKeybindingWatcher()

  // Both refreshes land while the first initialization is still awaiting its
  // directory stat, so the retry joins that stale promise.
  gate = false
  fireRefresh!()
  gate = true
  fireRefresh!()

  await pending
  await new Promise(r => setTimeout(r, 300))

  expect(hasFixtureBinding()).toBe(true)
  expect(watchCalls).toBe(1)
})

test('an absent gate enables customization', async () => {
  gate = undefined
  await mod.initializeKeybindingWatcher()

  expect(hasFixtureBinding()).toBe(true)
})

/**
 * The production shape of a kill switch: GrowthBook is disabled, so the getter
 * hands back its fallback without ever consulting the disk cache, and the
 * explicit `false` only exists in cachedGrowthBookFeatures. Reading it there is
 * the sole reason the gate still works in that state.
 */
test('an explicit false in the disk cache still disables customization', async () => {
  gate = undefined
  setCachedGate(false)

  expect(mod.isKeybindingCustomizationEnabled()).toBe(false)

  await mod.initializeKeybindingWatcher()
  expect(hasFixtureBinding()).toBe(false)
  expect(watchCalls).toBe(0)
})

test('an explicit true in the disk cache enables customization', async () => {
  gate = undefined
  setCachedGate(true)

  expect(mod.isKeybindingCustomizationEnabled()).toBe(true)

  await mod.initializeKeybindingWatcher()
  expect(hasFixtureBinding()).toBe(true)
})
