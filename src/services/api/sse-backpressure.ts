/**
 * The buffering half of a fetch adapter's stream translation.
 *
 * Both adapters that turn a third-party stream into Anthropic SSE — Codex and
 * DeepSeek — need the same plumbing: a pump that reads upstream as fast as it
 * arrives, a consumer that reads at its own pace, and a buffer between them
 * that must not grow without bound. It was written twice, character for
 * character, which is one copy too many for code whose failure mode is a
 * truncated or hung response rather than an exception.
 *
 */

import { logForDebugging } from '../../utils/debug.js'

/** The handle a pump uses to deliver bytes without outrunning the consumer. */
export type SseStreamSink = {
  /**
   * Buffers a chunk and hands over as much as the consumer will take. A no-op
   * once the stream is closed or cancelled.
   */
  enqueue: (chunk: Uint8Array) => void

  /**
   * Resolves once the consumer has taken everything buffered so far, or
   * immediately if the stream is done. Awaiting this between upstream chunks
   * is what stops a fast response from accumulating in memory ahead of a slow
   * reader.
   */
  waitForDrain: () => Promise<void>

  /** Whether the stream has been closed or cancelled. */
  readonly done: boolean

  /**
   * Registers the upstream body reader so a cancelled consumer cancels the
   * upstream request too. Pass null when the pump has released it.
   */
  setUpstreamReader: (
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
  ) => void

  /**
   * Waits for the consumer to take the trailing events, then closes. Closing
   * with chunks still buffered would truncate the response. A no-op if the
   * consumer cancelled while we were draining.
   */
  close: () => Promise<void>
}

/**
 * Builds the readable half of a translated SSE response.
 *
 * @param label - Provider name, used only in the cancel-path debug log
 * @param pump - Reads upstream and calls into the sink; started, not awaited
 * @returns The stream to hand to `new Response`, and the sink the pump writes
 *   to
 */
export function createBackpressuredSseStream(
  label: string,
  pump: () => Promise<void>,
): { readable: ReadableStream<Uint8Array>; sink: SseStreamSink } {
  const pendingBuffer: Uint8Array[] = []
  let bufferHead = 0
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let finished = false
  /** The consumer's cancel reason, kept so a late reader gets the same one. */
  let cancelReason: unknown = undefined
  /** Resolved once the consumer has taken everything buffered so far. */
  let notifyDrained: (() => void) | null = null
  /** Resolves a pending pull() once the pump produces something to deliver. */
  let notifyProduced: (() => void) | null = null

  function isBuffered(): boolean {
    return bufferHead < pendingBuffer.length
  }

  function drainBuffer(): void {
    const controller = streamController
    if (!controller) return
    while (
      isBuffered() &&
      controller.desiredSize !== null &&
      controller.desiredSize > 0
    ) {
      controller.enqueue(pendingBuffer[bufferHead]!)
      bufferHead++
    }
    if (!isBuffered()) {
      pendingBuffer.length = 0
      bufferHead = 0
      notifyDrained?.()
      notifyDrained = null
    }
  }

  /** Wakes both waiters — used when the stream ends or is cancelled. */
  function releaseWaiters(): void {
    notifyDrained?.()
    notifyDrained = null
    notifyProduced?.()
    notifyProduced = null
  }

  // Plain function declarations rather than methods, so a caller can pull
  // `enqueue` out into a local — both adapters do — without losing a `this`.
  function enqueue(chunk: Uint8Array): void {
    if (finished || streamController?.desiredSize === null) return
    pendingBuffer.push(chunk)
    drainBuffer()
    notifyProduced?.()
    notifyProduced = null
  }

  async function waitForDrain(): Promise<void> {
    if (finished || !isBuffered()) return
    await new Promise<void>(resolve => {
      notifyDrained = resolve
    })
  }

  async function close(): Promise<void> {
    await waitForDrain()
    if (finished) return
    finished = true
    releaseWaiters()
    streamController?.close()
  }

  const sink: SseStreamSink = {
    enqueue,
    waitForDrain,
    close,
    get done() {
      return finished
    },
    setUpstreamReader(reader) {
      // A consumer can cancel before the pump has a reader to register — it
      // only gets one after the upstream fetch resolves. Cancelling here rather
      // than storing it means that ordering leaks nothing: without this the
      // stream's own cancel() saw `upstreamReader === null` and the upstream
      // request stayed open until the process exited. The reason is the
      // consumer's own, so upstream sees the same one either way.
      if (finished && reader) {
        void reader.cancel(cancelReason).catch((error: unknown) => {
          logForDebugging(
            `${label} late upstream cancel error: ${String(error)}`,
            { level: 'debug' },
          )
        })
        return
      }
      upstreamReader = reader
    },
  }

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      // Deferred, for two reasons. `start()` runs inside the ReadableStream
      // constructor, which runs inside this function — so a pump that touched
      // the `sink` const its caller is still destructuring would hit the
      // temporal dead zone. And a `ReadableStream` never calls `pull()` until
      // `start()` settles, so awaiting the pump here would mean `pull()` did
      // not fire until the whole upstream response had been read and the
      // buffer had grown to the size of the response.
      queueMicrotask(() => void pump())
    },
    pull() {
      drainBuffer()
      if (isBuffered() || finished) return undefined
      // Nothing left to hand over: keep this pull() pending until the pump
      // produces more, otherwise the stream spins calling pull() on an empty
      // buffer.
      return new Promise<void>(resolve => {
        notifyProduced = resolve
      })
    },
    async cancel(reason) {
      finished = true
      cancelReason = reason
      // Nothing will ever read these now, and a cancelled stream can be held
      // alive by the pump's own frame until it notices.
      pendingBuffer.length = 0
      bufferHead = 0
      releaseWaiters()
      try {
        await upstreamReader?.cancel(reason)
      } catch (error) {
        // The reader may already be released or errored; the consumer has gone
        // either way, so there is nothing to recover, only something to record.
        logForDebugging(`${label} stream cancel error: ${String(error)}`, {
          level: 'debug',
        })
      }
    },
  })

  return { readable, sink }
}
