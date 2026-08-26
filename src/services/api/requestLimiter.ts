/**
 * Caps how many requests a provider has in flight at once.
 *
 * Anthropic sizes its limits so that a burst of parallel subagents is normal
 * traffic. Moonshot does not: its entry tiers allow a single concurrent
 * request, so the ten-way tool fan-out in toolOrchestration.ts turns into nine
 * rate-limit errors and one answer. Retrying them is the wrong fix — at 3
 * requests per minute the backoff is longer than the work — so the requests
 * have to be spaced out before they are sent.
 *
 * This sits at the fetch layer rather than in the query engine because that is
 * the one place every request already passes through: subagents, session
 * titles, WebFetch extraction and quota probes all end up here, and none of
 * them needs to know a limit exists.
 */

import { logForDebugging } from '../../utils/debug.js'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * A slot is held for as long as the request occupies the provider's
 * concurrency budget, which for a streaming response is until the last event
 * arrives — not until the headers do. `queryModel` consumes the stream well
 * after the fetch resolves, so releasing on resolution would let the whole
 * fan-out through at once and defeat the point.
 */
class ConcurrencyLimiter {
  private inFlight = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly maxConcurrent: number) {}

  async acquire(signal?: AbortSignal | null): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++
      return
    }
    logForDebugging(
      `[requestLimiter] queued behind ${this.inFlight} in-flight request(s)`,
    )
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        // Drop the waiter rather than letting an abandoned request hold up the
        // queue. The slot was never taken, so there is nothing to release.
        const index = this.waiting.indexOf(grant)
        if (index !== -1) {
          this.waiting.splice(index, 1)
        }
        reject(signal?.reason ?? new Error('Request aborted while queued'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(grant)
    })
  }

  release(): void {
    // Hand the slot straight to the next waiter instead of freeing and
    // re-taking it, so a third request cannot arrive in between and jump the
    // queue.
    const next = this.waiting.shift()
    if (next) {
      next()
      return
    }
    this.inFlight--
  }
}

/**
 * One limiter per provider, shared across clients.
 *
 * `getAnthropicClient()` builds a fresh client per request — and again per
 * retry attempt — so a limiter owned by the client would start empty every
 * time and never limit anything. The count has to outlive the client.
 */
const limiters = new Map<string, ConcurrencyLimiter>()

/**
 * Wraps a fetch so at most `maxConcurrent` of its requests are in flight.
 *
 * The returned fetch holds a slot until the response body is finished,
 * cancelled, or errors. A caller that drops a response without reading or
 * cancelling it would strand the slot, but that also strands the connection,
 * so the SDK never does it: it either parses the body, cancels it, or the
 * abort signal tears the whole request down.
 *
 * @param key - Provider identity; requests sharing a key share a budget
 * @param maxConcurrent - Requests allowed in flight at once
 * @param inner - The fetch to delegate to
 * @returns A fetch suitable for the Anthropic SDK's `fetch` option
 */
export function limitRequestConcurrency(
  key: string,
  maxConcurrent: number,
  inner: FetchFn = globalThis.fetch,
): FetchFn {
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = new ConcurrencyLimiter(maxConcurrent)
    limiters.set(key, limiter)
  }
  const shared = limiter

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
    await shared.acquire(signal)

    let released = false
    const release = () => {
      if (released) {
        return
      }
      released = true
      signal?.removeEventListener('abort', release)
      shared.release()
    }
    // A caller that aborts mid-response may never touch the body again; the
    // slot has to come back anyway.
    signal?.addEventListener('abort', release, { once: true })

    let response: Response
    try {
      response = await inner(input, init)
    } catch (err) {
      release()
      throw err
    }

    if (!response.body) {
      release()
      return response
    }

    const reader = response.body.getReader()
    const tracked = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            release()
            controller.close()
            return
          }
          controller.enqueue(value)
        } catch (err) {
          release()
          controller.error(err)
        }
      },
      cancel(reason) {
        release()
        return reader.cancel(reason)
      },
    })

    // Rebuilt rather than patched because `.json()` and `.text()` read the
    // body the Response was constructed with, not whatever `.body` was
    // reassigned to — patching would release the slot only for streaming
    // requests. `url` is lost in the process; the SDK reads it for debug
    // logging alone.
    return new Response(tracked, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
