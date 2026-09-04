import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../debug.js'
import type { ShellCommand } from '../ShellCommand.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { emitHookResponse, startHookProgressInterval } from './hookEvents.js'

export type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  /**
   * Set when the hook was killed for exceeding its timeout. Checked before the
   * plain 'killed' handling so the timeout is reported rather than discarded.
   */
  timedOut: boolean
  /** Stops both the progress interval and the timeout timer for this hook. */
  stopTimers: () => void
}

/**
 * Deadline applied to a hook that answered `{"async": true}` without naming an
 * asyncTimeout. Carried over from the previous `asyncTimeout || 15000`; it is
 * not documented anywhere outside this file.
 */
const DEFAULT_ASYNC_HOOK_TIMEOUT_MS = 15_000

/**
 * Deadline for a hook backgrounded because settings marked it `async`, rather
 * than because it answered `{"async": true}` on stdout.
 *
 * Such a hook never named a deadline: `timeout` in settings bounds *synchronous*
 * execution, and reusing it here would kill a `{"timeout": 30, "async": true}`
 * hook after 30s — the combination someone writes precisely because the hook is
 * slow, and which ran unbounded before this deadline existed. So this is a
 * backstop against outliving the session, not a latency budget, and it is set
 * far longer than the default a self-declared async hook gets.
 */
export const CONFIG_ASYNC_HOOK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Largest delay setTimeout accepts. Anything above it — Infinity included — is
 * silently turned into 1ms, so requests beyond this are clamped down to it
 * rather than allowed through.
 */
const MAX_ASYNC_HOOK_TIMEOUT_MS = 2 ** 31 - 1

// Global registry state
const pendingHooks = new Map<string, PendingAsyncHook>()

export function registerPendingAsyncHook({
  processId,
  hookId,
  asyncResponse,
  hookName,
  hookEvent,
  command,
  shellCommand,
  toolName,
  pluginId,
}: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  command: string
  shellCommand: ShellCommand
  toolName?: string
  pluginId?: string
}): void {
  // asyncTimeout is read off the hook's own stdout, so it can be any JSON
  // value: isAsyncHookJSONOutput only checks `json.async === true`, and no zod
  // schema is applied to the parsed line. Narrow it to a usable timer delay
  // rather than trusting it, keeping the existing default.
  //
  // The upper clamp is not cosmetic. setTimeout silently rewrites a delay above
  // 2**31-1 — or Infinity, which `JSON.parse('{"asyncTimeout":1e999}')` yields —
  // to 1ms, so an unclamped hook asking for the longest possible deadline would
  // be killed almost immediately: the exact inverse of what it asked for.
  const requestedTimeout = asyncResponse.asyncTimeout
  const timeout =
    typeof requestedTimeout === 'number' && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_ASYNC_HOOK_TIMEOUT_MS)
      : DEFAULT_ASYNC_HOOK_TIMEOUT_MS
  logForDebugging(
    `Hooks: Registering async hook ${processId} (${hookName}) with timeout ${timeout}ms`,
  )
  const stopProgressInterval = startHookProgressInterval({
    hookId,
    hookName,
    hookEvent,
    getOutput: async () => {
      const taskOutput = pendingHooks.get(processId)?.shellCommand?.taskOutput
      if (!taskOutput) {
        return { stdout: '', stderr: '', output: '' }
      }
      const stdout = await taskOutput.getStdout()
      const stderr = taskOutput.getStderr()
      return { stdout, stderr, output: stdout + stderr }
    },
  })
  // Backgrounding a ShellCommand clears the timeout timer wrapSpawn installed
  // (ShellCommand.background -> #cleanupListeners), and the compensating size
  // watchdog only runs in file mode — hooks run in pipe mode. So nothing else
  // bounds an async hook: without this timer a hook that never exits stays
  // 'backgrounded' forever, which checkForAsyncHookResponses skips on every
  // pass, and it survives until shutdown.
  const timeoutTimer = setTimeout(() => {
    void expireAsyncHook(processId)
  }, timeout)
  timeoutTimer.unref()

  pendingHooks.set(processId, {
    processId,
    hookId,
    hookName,
    hookEvent,
    toolName,
    pluginId,
    command,
    startTime: Date.now(),
    timeout,
    responseAttachmentSent: false,
    shellCommand,
    timedOut: false,
    stopTimers: () => {
      stopProgressInterval()
      clearTimeout(timeoutTimer)
    },
  })
}

/**
 * Kills an async hook that outlived its timeout, and flags it so the next
 * checkForAsyncHookResponses pass reports it instead of dropping it.
 *
 * The report is deliberately left to that pass rather than emitted here: this
 * module is imported by attachments.ts, so reaching the notification helpers
 * directly would close an import cycle through messages.ts.
 *
 * Hooks whose process already exited are left alone — they have real output to
 * deliver, and the normal path owns them.
 */
function expireAsyncHook(processId: string): void {
  const hook = pendingHooks.get(processId)
  if (!hook || hook.responseAttachmentSent || hook.timedOut) {
    return
  }
  if (hook.shellCommand?.status === 'completed') {
    return
  }
  logForDebugging(
    `Hooks: Async hook ${processId} (${hook.hookName}) exceeded its ${hook.timeout}ms asyncTimeout, killing it`,
    { level: 'warn' },
  )
  hook.timedOut = true
  hook.stopTimers()
  if (hook.shellCommand && hook.shellCommand.status !== 'killed') {
    hook.shellCommand.kill()
  }
}

export function getPendingAsyncHooks(): PendingAsyncHook[] {
  return Array.from(pendingHooks.values()).filter(
    hook => !hook.responseAttachmentSent,
  )
}

async function finalizeHook(
  hook: PendingAsyncHook,
  exitCode: number,
  outcome: 'success' | 'error' | 'cancelled',
): Promise<void> {
  hook.stopTimers()
  const taskOutput = hook.shellCommand?.taskOutput
  const stdout = taskOutput ? await taskOutput.getStdout() : ''
  const stderr = taskOutput?.getStderr() ?? ''
  hook.shellCommand?.cleanup()
  emitHookResponse({
    hookId: hook.hookId,
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    output: stdout + stderr,
    stdout,
    stderr,
    exitCode,
    outcome,
  })
}

export async function checkForAsyncHookResponses(): Promise<
  Array<{
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    stdout: string
    stderr: string
    exitCode?: number
  }>
> {
  const responses: {
    processId: string
    response: SyncHookJSONOutput
    hookName: string
    hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
    toolName?: string
    pluginId?: string
    stdout: string
    stderr: string
    exitCode?: number
  }[] = []

  const pendingCount = pendingHooks.size
  logForDebugging(`Hooks: Found ${pendingCount} total hooks in registry`)

  // Snapshot hooks before processing — we'll mutate the map after.
  const hooks = Array.from(pendingHooks.values())

  const settled = await Promise.allSettled(
    hooks.map(async hook => {
      const stdout = (await hook.shellCommand?.taskOutput.getStdout()) ?? ''
      const stderr = hook.shellCommand?.taskOutput.getStderr() ?? ''
      logForDebugging(
        `Hooks: Checking hook ${hook.processId} (${hook.hookName}) - attachmentSent: ${hook.responseAttachmentSent}, stdout length: ${stdout.length}`,
      )

      if (!hook.shellCommand) {
        logForDebugging(
          `Hooks: Hook ${hook.processId} has no shell command, removing from registry`,
        )
        hook.stopTimers()
        return { type: 'remove' as const, processId: hook.processId }
      }

      logForDebugging(`Hooks: Hook shell status ${hook.shellCommand.status}`)

      // Must precede the 'killed' branch: expireAsyncHook kills the process, so
      // a timed-out hook would otherwise be silently discarded there.
      if (hook.timedOut) {
        const exitCode = (await hook.shellCommand.result).code
        hook.responseAttachmentSent = true
        await finalizeHook(hook, exitCode, 'error')
        return {
          type: 'response' as const,
          processId: hook.processId,
          isSessionStart: hook.hookEvent === 'SessionStart',
          payload: {
            processId: hook.processId,
            response: {
              // No advice to raise "asyncTimeout" here: a hook backgrounded by
              // the `async` setting never emits an async response to raise it
              // in, so that instruction would be impossible to follow for one
              // of the two ways a hook reaches this registry.
              systemMessage:
                `Async hook "${hook.hookName}" (${hook.hookEvent}) exceeded its ` +
                `${hook.timeout}ms asyncTimeout and was killed.`,
            },
            hookName: hook.hookName,
            hookEvent: hook.hookEvent,
            toolName: hook.toolName,
            pluginId: hook.pluginId,
            stdout,
            stderr,
            exitCode,
          },
        }
      }

      if (hook.shellCommand.status === 'killed') {
        logForDebugging(
          `Hooks: Hook ${hook.processId} is ${hook.shellCommand.status}, removing from registry`,
        )
        hook.stopTimers()
        hook.shellCommand.cleanup()
        return { type: 'remove' as const, processId: hook.processId }
      }

      if (hook.shellCommand.status !== 'completed') {
        return { type: 'skip' as const }
      }

      if (hook.responseAttachmentSent || !stdout.trim()) {
        logForDebugging(
          `Hooks: Skipping hook ${hook.processId} - already delivered/sent or no stdout`,
        )
        hook.stopTimers()
        return { type: 'remove' as const, processId: hook.processId }
      }

      const lines = stdout.split('\n')
      logForDebugging(
        `Hooks: Processing ${lines.length} lines of stdout for ${hook.processId}`,
      )

      const execResult = await hook.shellCommand.result
      const exitCode = execResult.code

      let response: SyncHookJSONOutput = {}
      for (const line of lines) {
        if (line.trim().startsWith('{')) {
          logForDebugging(
            `Hooks: Found JSON line: ${line.trim().substring(0, 100)}...`,
          )
          try {
            const parsed = jsonParse(line.trim())
            if (!('async' in parsed)) {
              logForDebugging(
                `Hooks: Found sync response from ${hook.processId}: ${jsonStringify(parsed)}`,
              )
              response = parsed
              break
            }
          } catch {
            logForDebugging(
              `Hooks: Failed to parse JSON from ${hook.processId}: ${line.trim()}`,
            )
          }
        }
      }

      hook.responseAttachmentSent = true
      await finalizeHook(hook, exitCode, exitCode === 0 ? 'success' : 'error')

      return {
        type: 'response' as const,
        processId: hook.processId,
        isSessionStart: hook.hookEvent === 'SessionStart',
        payload: {
          processId: hook.processId,
          response,
          hookName: hook.hookName,
          hookEvent: hook.hookEvent,
          toolName: hook.toolName,
          pluginId: hook.pluginId,
          stdout,
          stderr,
          exitCode,
        },
      }
    }),
  )

  // allSettled — isolate failures so one throwing callback doesn't orphan
  // already-applied side effects (responseAttachmentSent, finalizeHook) from others.
  let sessionStartCompleted = false
  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      logForDebugging(
        `Hooks: checkForAsyncHookResponses callback rejected: ${s.reason}`,
        { level: 'error' },
      )
      continue
    }
    const r = s.value
    if (r.type === 'remove') {
      pendingHooks.delete(r.processId)
    } else if (r.type === 'response') {
      responses.push(r.payload)
      pendingHooks.delete(r.processId)
      if (r.isSessionStart) sessionStartCompleted = true
    }
  }

  if (sessionStartCompleted) {
    logForDebugging(
      `Invalidating session env cache after SessionStart hook completed`,
    )
    invalidateSessionEnvCache()
  }

  logForDebugging(
    `Hooks: checkForNewResponses returning ${responses.length} responses`,
  )
  return responses
}

export function removeDeliveredAsyncHooks(processIds: string[]): void {
  for (const processId of processIds) {
    const hook = pendingHooks.get(processId)
    if (hook && hook.responseAttachmentSent) {
      logForDebugging(`Hooks: Removing delivered hook ${processId}`)
      hook.stopTimers()
      pendingHooks.delete(processId)
    }
  }
}

export async function finalizePendingAsyncHooks(): Promise<void> {
  const hooks = Array.from(pendingHooks.values())
  await Promise.all(
    hooks.map(async hook => {
      if (hook.shellCommand?.status === 'completed') {
        const result = await hook.shellCommand.result
        await finalizeHook(
          hook,
          result.code,
          result.code === 0 ? 'success' : 'error',
        )
      } else {
        if (hook.shellCommand && hook.shellCommand.status !== 'killed') {
          hook.shellCommand.kill()
        }
        await finalizeHook(hook, 1, 'cancelled')
      }
    }),
  )
  pendingHooks.clear()
}

// Test utility function to clear all hooks
export function clearAllAsyncHooks(): void {
  for (const hook of pendingHooks.values()) {
    hook.stopTimers()
  }
  pendingHooks.clear()
}
