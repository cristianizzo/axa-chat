import axios from 'axios'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { coerce } from 'semver'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isENOENT, toError } from './errors.js'
import { logError } from './log.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { gt } from './semver.js'

const MAX_RELEASE_NOTES_SHOWN = 5

/** How long to wait before re-checking a repo that published no changelog. */
const CHANGELOG_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * We fetch the changelog from GitHub instead of bundling it with the build.
 *
 * This is necessary because Ink's static rendering makes it difficult to
 * dynamically update/show components after initial render. By storing the
 * changelog in config, we ensure it's available on the next startup without
 * requiring a full re-render of the current UI.
 *
 * The flow is:
 * 1. User updates to a new version
 * 2. We fetch the changelog in the background and store it in config
 * 3. Next time the user starts Claude, the cached changelog is available immediately
 */
/**
 * This fork's own changelog, not the upstream project it was forked from.
 *
 * These pointed at `anthropics/claude-code`. Because this fork inherits that
 * project's version numbering the entries matched, so the startup banner's
 * "What's new" feed and `/release-notes` presented another product's release
 * notes as this one's — users saw lines about Claude Max subscriptions and
 * organization-managed logins describing releases this build never shipped.
 *
 * Until a CHANGELOG.md exists at the URL below the fetch finds nothing, the
 * cache stays empty, and the feed falls back to its own empty message. Silent
 * and true beats confident and wrong.
 */
export const CHANGELOG_URL =
  'https://github.com/cristianizzo/axa-chat/blob/main/CHANGELOG.md'
const RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/cristianizzo/axa-chat/refs/heads/main/CHANGELOG.md'

/**
 * Get the path for the cached changelog file, under this install's config dir.
 *
 * Deliberately not the old `changelog.md`. Every existing install has one of
 * those holding the upstream changelog this fork used to fetch, and reading it
 * back would keep showing another product's release notes long after the URL
 * was corrected. A new name means those caches are simply never read again;
 * `pruneUpstreamChangelogCache` deletes them.
 */
function getChangelogCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'changelog-axa.md')
}

/** The pre-fork cache, holding upstream's changelog. Read by no one now. */
function getUpstreamChangelogCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'changelog.md')
}

// In-memory cache populated by async reads. Sync callers (React render, sync
// helpers) read from this cache after setup.ts awaits checkForReleaseNotes().
let changelogMemoryCache: string | null = null

/** @internal exported for tests */
export function _resetChangelogCacheForTesting(): void {
  changelogMemoryCache = null
}

/**
 * Drop every trace of the upstream changelog this fork used to fetch.
 *
 * Two places hold it on an existing install: the deprecated `cachedChangelog`
 * config field, and the `changelog.md` cache file. Both contain upstream's
 * release notes, so both are discarded rather than carried forward.
 *
 * This replaces a migration that copied `cachedChangelog` into the cache file.
 * That was correct while the two changelogs were the same document; now it
 * would seed this fork's cache with another product's notes and defeat the
 * point of changing the URL — the loudest possible version of the bug, since
 * it survives having no CHANGELOG.md of our own.
 *
 * `changelogLastFetched` goes with them: it timed a fetch of the upstream URL,
 * so leaving it in place would let the retry back-off throttle the *new* URL's
 * very first fetch for up to a day. Clearing it is deliberately conditional on
 * having actually found upstream state — clearing it on every start would wipe
 * the stamp the back-off measures from, and the back-off would never engage.
 *
 * Called once at startup, before any other config save can re-add the field.
 * Best-effort throughout: a file we cannot delete is still a file nobody reads.
 */
export async function discardUpstreamChangelogState(): Promise<void> {
  let hadUpstreamState = false

  try {
    // Not `force`: the ENOENT tells us there was nothing to carry forward,
    // which is exactly the signal the conditional below needs.
    await rm(getUpstreamChangelogCachePath())
    hadUpstreamState = true
  } catch (error) {
    // Only ENOENT means "there was no upstream state". Any other failure
    // (a permission problem, say) means the file was there and we could not
    // remove it — still upstream state, and the stamp below must go.
    if (!isENOENT(error)) {
      hadUpstreamState = true
    }
  }

  if (getGlobalConfig().cachedChangelog) {
    hadUpstreamState = true
  }

  if (!hadUpstreamState) {
    return
  }

  // One write for both: dropping the deprecated field, and the stamp that
  // measured the old URL.
  saveGlobalConfig(
    ({ cachedChangelog: _content, changelogLastFetched: _stamp, ...rest }) =>
      rest,
  )
}

/**
 * Fetch the changelog from GitHub and store it in cache file
 * This runs in the background and doesn't block the UI
 */
export async function fetchAndStoreChangelog(): Promise<void> {
  // Skip in noninteractive mode
  if (getIsNonInteractiveSession()) {
    return
  }

  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  // checkForReleaseNotes re-fetches whenever the cache is empty, so a repo
  // with no CHANGELOG.md would hit the network on every single start, for
  // ever. Back that case off to once a day. Only the empty case is throttled:
  // a cache that exists is refreshed as eagerly as before, so a real changelog
  // still updates the moment the version changes.
  if (!(await getStoredChangelog())) {
    const lastFetched = getGlobalConfig().changelogLastFetched ?? 0
    if (Date.now() - lastFetched < CHANGELOG_RETRY_INTERVAL_MS) {
      return
    }
  }

  // 404 is an expected answer, not a failure: the repo need not publish a
  // CHANGELOG.md, and letting axios throw would log an error on every start
  // for a file whose absence is a valid state. Anything else still throws and
  // is reported by the caller.
  const response = await axios.get(RAW_CHANGELOG_URL, {
    validateStatus: status => status === 200 || status === 404,
  })
  if (response.status === 404) {
    // Record the attempt so the throttle above can see it. Without this the
    // back-off has nothing to measure from and never engages.
    recordChangelogFetchAttempt()
    return
  }
  if (response.status === 200) {
    const changelogContent = response.data

    // Skip write if content unchanged — writing Date.now() defeats the
    // dirty-check in saveGlobalConfig since the timestamp always differs.
    if (changelogContent === changelogMemoryCache) {
      return
    }

    const cachePath = getChangelogCachePath()

    // Ensure cache directory exists
    await mkdir(dirname(cachePath), { recursive: true })

    // Write changelog to cache file
    await writeFile(cachePath, changelogContent, { encoding: 'utf-8' })
    changelogMemoryCache = changelogContent

    recordChangelogFetchAttempt()
  }
}

/** Stamp the last fetch attempt, which is what the retry back-off reads. */
function recordChangelogFetchAttempt(): void {
  const changelogLastFetched = Date.now()
  saveGlobalConfig(current => ({
    ...current,
    changelogLastFetched,
  }))
}

/**
 * Get the stored changelog from cache file if available.
 * Populates the in-memory cache for subsequent sync reads.
 * @returns The cached changelog content or empty string if not available
 */
export async function getStoredChangelog(): Promise<string> {
  if (changelogMemoryCache !== null) {
    return changelogMemoryCache
  }
  const cachePath = getChangelogCachePath()
  try {
    const content = await readFile(cachePath, 'utf-8')
    changelogMemoryCache = content
    return content
  } catch {
    changelogMemoryCache = ''
    return ''
  }
}

/**
 * Synchronous accessor for the changelog, reading only from the in-memory cache.
 * Returns empty string if the async getStoredChangelog() hasn't been called yet.
 * Intended for React render paths where async is not possible; setup.ts ensures
 * the cache is populated before first render via `await checkForReleaseNotes()`.
 */
export function getStoredChangelogFromMemory(): string {
  return changelogMemoryCache ?? ''
}

/**
 * Parses a changelog string in markdown format into a structured format
 * @param content - The changelog content string
 * @returns Record mapping version numbers to arrays of release notes
 */
export function parseChangelog(content: string): Record<string, string[]> {
  try {
    if (!content) return {}

    // Parse the content
    const releaseNotes: Record<string, string[]> = {}

    // Split by heading lines (## X.X.X)
    const sections = content.split(/^## /gm).slice(1) // Skip the first section which is the header

    for (const section of sections) {
      const lines = section.trim().split('\n')
      if (lines.length === 0) continue

      // Extract version from the first line
      // Handle both "1.2.3" and "1.2.3 - YYYY-MM-DD" formats
      const versionLine = lines[0]
      if (!versionLine) continue

      // First part before any dash is the version
      const version = versionLine.split(' - ')[0]?.trim() || ''
      if (!version) continue

      // Extract bullet points
      const notes = lines
        .slice(1)
        .filter(line => line.trim().startsWith('- '))
        .map(line => line.trim().substring(2).trim())
        .filter(Boolean)

      if (notes.length > 0) {
        releaseNotes[version] = notes
      }
    }

    return releaseNotes
  } catch (error) {
    logError(toError(error))
    return {}
  }
}

/**
 * Gets release notes to show based on the previously seen version.
 * Shows up to MAX_RELEASE_NOTES_SHOWN items total, prioritizing the most recent versions.
 *
 * @param currentVersion - The current app version
 * @param previousVersion - The last version where release notes were seen (or null if first time)
 * @param readChangelog - Function to read the changelog (defaults to readChangelogFile)
 * @returns Array of release notes to display
 */
export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent: string = getStoredChangelogFromMemory(),
): string[] {
  try {
    return getRecentReleaseNoteGroups(
      currentVersion,
      previousVersion,
      changelogContent,
    )
      .flatMap(([, notes]) => notes)
      .filter(Boolean)
      .slice(0, MAX_RELEASE_NOTES_SHOWN)
  } catch (error) {
    logError(toError(error))
    return []
  }
  return []
}

export function getRecentReleaseNoteGroups(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent: string = getStoredChangelogFromMemory(),
  maxVersions: number = Number.POSITIVE_INFINITY,
): Array<[string, string[]]> {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // Strip SHA/build metadata from both versions to compare only the base semver.
    const baseCurrentVersion = coerce(currentVersion)
    const basePreviousVersion = previousVersion ? coerce(previousVersion) : null

    if (!baseCurrentVersion) {
      return []
    }

    if (
      basePreviousVersion &&
      !gt(baseCurrentVersion.version, basePreviousVersion.version)
    ) {
      return []
    }

    return Object.entries(releaseNotes)
      .filter(
        ([version]) =>
          !basePreviousVersion || gt(version, basePreviousVersion.version),
      )
      .sort(([versionA], [versionB]) => (gt(versionA, versionB) ? -1 : 1))
      .slice(0, maxVersions)
      .map(([version, notes]) => [version, notes.filter(Boolean)] as [string, string[]])
      .filter(([, notes]) => notes.length > 0)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * Gets all release notes as an array of [version, notes] arrays.
 * Versions are sorted with oldest first.
 *
 * @param readChangelog - Function to read the changelog (defaults to readChangelogFile)
 * @returns Array of [version, notes[]] arrays
 */
export function getAllReleaseNotes(
  changelogContent: string = getStoredChangelogFromMemory(),
): Array<[string, string[]]> {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // Sort versions with oldest first
    const sortedVersions = Object.keys(releaseNotes).sort((a, b) =>
      gt(a, b) ? 1 : -1,
    )

    // Return array of [version, notes] arrays
    return sortedVersions
      .map(version => {
        const versionNotes = releaseNotes[version]
        if (!versionNotes || versionNotes.length === 0) return null

        const notes = versionNotes.filter(Boolean)
        if (notes.length === 0) return null

        return [version, notes] as [string, string[]]
      })
      .filter((item): item is [string, string[]] => item !== null)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * Checks if there are release notes to show based on the last seen version.
 * Can be used by multiple components to determine whether to display release notes.
 * Also triggers a fetch of the latest changelog if the version has changed.
 *
 * @param lastSeenVersion The last version of release notes the user has seen
 * @param currentVersion The current application version, defaults to MACRO.VERSION
 * @returns An object with hasReleaseNotes and the releaseNotes content
 */
export async function checkForReleaseNotes(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  // For Ant builds, use VERSION_CHANGELOG bundled at build time
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  // Ensure the in-memory cache is populated for subsequent sync reads
  const cachedChangelog = await getStoredChangelog()

  // If the version has changed or we don't have a cached changelog, fetch a new one
  // This happens in the background and doesn't block the UI
  if (lastSeenVersion !== currentVersion || !cachedChangelog) {
    fetchAndStoreChangelog().catch(error => logError(toError(error)))
  }

  const releaseNotes = getRecentReleaseNotes(
    currentVersion,
    lastSeenVersion,
    cachedChangelog,
  )
  const hasReleaseNotes = releaseNotes.length > 0

  return {
    hasReleaseNotes,
    releaseNotes,
  }
}

/**
 * Synchronous variant of checkForReleaseNotes for React render paths.
 * Reads only from the in-memory cache populated by the async version.
 * setup.ts awaits checkForReleaseNotes() before first render, so this
 * returns accurate results in component render bodies.
 */
export function checkForReleaseNotesSync(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  // For Ant builds, use VERSION_CHANGELOG bundled at build time
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  const releaseNotes = getRecentReleaseNotes(currentVersion, lastSeenVersion)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}
