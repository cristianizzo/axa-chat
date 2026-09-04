import { chmodSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      try {
        // 0700 applies only when this actually creates the directory, and
        // storageDir is the whole config home, which on any existing install
        // already exists at 0755. So this hardens a fresh install and changes
        // nothing for everyone else — it is not the fix, and nothing below
        // should depend on the directory being private. The mode on the write
        // is the fix.
        getFsImplementation().mkdirSync(storageDir, { mode: 0o700 })
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      // SECURITY: create the file private rather than chmod'ing it private
      // after the credentials are already on disk. Without `mode` this goes to
      // fs.writeFileSync with no mode and lands at 0666 & ~umask — measured at
      // 0644, in a 0755 directory, holding a plaintext token. That is an
      // exposure window, not a race: nothing has to be timed, the directory
      // just has to be listable.
      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: false,
        mode: 0o600,
      })
      // Still needed, and not redundant with the line above: `mode` applies
      // only when open(2) creates the file, so a credentials file that already
      // exists at a wider mode — including every one written by a build before
      // this change — keeps that mode through the rewrite. This narrows it.
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
