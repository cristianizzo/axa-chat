import { spawn } from 'child_process'
import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'

/**
 * Relaunches the running CLI in place — mainly so a rebuilt binary (after
 * `/update`) takes effect without the user having to quit and retype the
 * launch command.
 *
 * The replacement is spawned from the process 'exit' handler, which fires
 * synchronously right before the process dies. By then gracefulShutdown has
 * already restored the terminal (exited the alt screen, shown the cursor, left
 * raw mode), so the child renders onto a clean screen rather than fighting the
 * outgoing REPL for it.
 *
 * `process.execPath` + `process.argv.slice(1)` reproduces the exact invocation:
 * in a compiled build execPath is the axa binary and argv carries the user's
 * flags; in source mode (`bun run dev`) execPath is bun and argv carries the
 * entrypoint plus flags. `detached: false` keeps the child in this process's
 * group, which is the terminal's foreground group — so once we exit the child
 * owns the TTY instead of getting stopped with SIGTTIN on its first read.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  process.once('exit', () => {
    spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      detached: false,
    })
  })
  onDone('Restarting axa…')
  await gracefulShutdown(0, 'other')
  return null
}
