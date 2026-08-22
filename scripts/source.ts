import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Source-tree provenance for installs that have no git checkout.
 *
 * `install.sh` clones with git when it is available, but git is not installable
 * on every machine someone wants to run axa on. Without it the installer falls
 * back to downloading a source tarball from GitHub, which leaves no `.git` to
 * read the current revision from — so the tarball path writes the marker file
 * below instead, and `scripts/update.ts` / `scripts/build.ts` read it wherever
 * they would otherwise have shelled out to git.
 *
 * Keep this in sync with the tarball logic in `install.sh`, which performs the
 * very first fetch (it runs before this file exists on disk) and writes the
 * same marker.
 */

export const DEFAULT_REPO_SLUG = 'cristianizzo/axa-chat'
export const DEFAULT_REF = 'main'

/** Written at the source-tree root by tarball installs; absent for git checkouts. */
export const INSTALL_MARKER = '.axa-install.json'

export type InstallMarker = {
  source: 'tarball'
  repo: string
  ref: string
  /** Full 40-char commit SHA the tree was extracted from. */
  commit: string
  updatedAt: string
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
// `owner/name` with the characters GitHub actually allows. Enforced because the
// value is interpolated into API and download URLs, where a stray `/` or `..`
// would silently redirect the fetch somewhere else.
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
// Refs go through encodeURIComponent, so this only needs to exclude the shapes
// git itself rejects.
const REF_PATTERN = /^[^\s~^:?*[\\]+$/

/**
 * Read the tarball marker, or null when absent, unreadable or malformed.
 *
 * Validation is strict because `scripts/update.ts` uses a non-null result as
 * the gate for unpacking a tarball over the directory: a file that is not
 * recognisably one of our markers must read as absent, so the updater refuses
 * rather than extracting somewhere it should not.
 */
export function readInstallMarker(dir: string): InstallMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, INSTALL_MARKER), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { source, repo, ref, commit, updatedAt } = parsed as Record<string, unknown>

  if (source !== undefined && source !== 'tarball') return null
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) return null

  // `repo` and `ref` may be omitted (the defaults are what the installer
  // writes), but a present-and-invalid value is rejected rather than silently
  // replaced — it means the file is not one of ours.
  let repoSlug = DEFAULT_REPO_SLUG
  if (repo !== undefined) {
    if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null
    repoSlug = repo
  }
  let refName = DEFAULT_REF
  if (ref !== undefined) {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return null
    refName = ref
  }

  return {
    source: 'tarball',
    repo: repoSlug,
    ref: refName,
    commit,
    // Cosmetic only, so a bad value degrades to empty instead of rejecting.
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  }
}

export function writeInstallMarker(
  dir: string,
  marker: Pick<InstallMarker, 'repo' | 'ref' | 'commit'>,
): void {
  const contents: InstallMarker = {
    source: 'tarball',
    ...marker,
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, INSTALL_MARKER), `${JSON.stringify(contents, null, 2)}\n`)
}

const USER_AGENT = 'axa-chat-updater'

/** Resolve `ref` to a commit SHA over the GitHub API (no git required). */
export async function resolveLatestCommit(repo: string, ref: string): Promise<string> {
  // The `vnd.github.sha` media type returns the bare SHA as text/plain, which
  // avoids parsing the (large) commit JSON just to read one field.
  const res = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    { headers: { accept: 'application/vnd.github.sha', 'user-agent': USER_AGENT } },
  )
  if (!res.ok) {
    throw new Error(
      `GitHub returned ${res.status} ${res.statusText} while resolving ${repo}@${ref}.`,
    )
  }
  const sha = (await res.text()).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Unexpected commit SHA for ${repo}@${ref}: ${JSON.stringify(sha.slice(0, 80))}`)
  }
  return sha
}

/**
 * Download `repo` at `sha` and extract it over `dir`, then record the revision.
 *
 * The tarball is written to a temp file before extraction so a failed or
 * truncated download cannot leave a half-written source tree behind.
 *
 * Extraction overwrites in place and never deletes: files removed upstream
 * linger as orphans. That is deliberate — the alternative (clearing the tree
 * first) risks destroying user data that lives at the source root and is
 * gitignored rather than shipped, such as `.claude/` or a conversation backup.
 * Orphaned source files are inert, since nothing in the new tree imports them.
 */
export async function syncFromTarball(
  dir: string,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, {
    headers: { 'user-agent': USER_AGENT },
  })
  if (!res.ok) {
    throw new Error(
      `GitHub returned ${res.status} ${res.statusText} while downloading ${repo}@${sha.slice(0, 8)}.`,
    )
  }

  const tmpFile = join(mkdtempSync(join(tmpdir(), 'axa-src-')), 'source.tar.gz')
  try {
    writeFileSync(tmpFile, new Uint8Array(await res.arrayBuffer()))
    // --strip-components=1 drops GitHub's `<repo>-<sha>/` wrapper directory.
    execFileSync('tar', ['-xzf', tmpFile, '--strip-components=1', '-C', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } finally {
    rmSync(dirname(tmpFile), { recursive: true, force: true })
  }

  writeInstallMarker(dir, { repo, ref, commit: sha })
}
