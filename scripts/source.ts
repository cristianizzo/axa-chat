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

/** Read the tarball marker, or null when absent/unreadable/malformed. */
export function readInstallMarker(dir: string): InstallMarker | null {
  let parsed: Partial<InstallMarker>
  try {
    parsed = JSON.parse(readFileSync(join(dir, INSTALL_MARKER), 'utf8')) as Partial<InstallMarker>
  } catch {
    return null
  }
  // The commit is the only field with no sensible default — without it the
  // marker cannot answer "what revision is this?", so treat it as absent.
  if (typeof parsed.commit !== 'string' || !parsed.commit) return null
  return {
    source: 'tarball',
    repo: parsed.repo || DEFAULT_REPO_SLUG,
    ref: parsed.ref || DEFAULT_REF,
    commit: parsed.commit,
    updatedAt: parsed.updatedAt || '',
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
