/**
 * A local `count_tokens` for backends that speak Anthropic natively.
 *
 * Ollama v0.14+ and Moonshot both serve a native Anthropic `/v1/messages`, so
 * unlike Codex they need no request/response translation — pointing the SDK's
 * baseURL at them is enough. Neither documents `/v1/messages/count_tokens`, and
 * probing an endpoint that may not be there can stall a session. This wrapper
 * answers that one path locally and delegates everything else untouched.
 *
 * Nothing in it is specific to either backend — it keys off the request path
 * alone — so a third native-Anthropic provider can reuse it unchanged.
 */

import { logError } from '../../utils/log.js'

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Builds an Anthropic-shaped `count_tokens` response from a local estimate.
 *
 * Mirrors the Codex adapter: these compat layers have no working count_tokens
 * endpoint, so estimate from the serialised prompt instead of letting the SDK
 * hang on it.
 *
 * `roughTokenCountEstimation` is imported dynamically because
 * `tokenEstimation.ts` imports `client.ts`, which imports this module — a static
 * import would close that cycle at module-evaluation time.
 *
 * @param anthropicBody - The parsed Anthropic count_tokens request body
 * @returns A Response containing `{ input_tokens }`
 */
async function estimateTokenCountResponse(
  anthropicBody: Record<string, unknown>,
): Promise<Response> {
  const { roughTokenCountEstimation } = await import('../tokenEstimation.js')
  const countable = JSON.stringify(
    [anthropicBody.system ?? '', anthropicBody.messages ?? [], anthropicBody.tools ?? []],
    // Base64 image and document payloads are orders of magnitude larger than
    // the tokens they represent; counting them verbatim would inflate the
    // estimate enough to trigger spurious compaction. Keyed on the enclosing
    // object being a base64 `source` rather than the key name alone, so a tool
    // input with its own `data` field is still counted. Needs `function` for
    // `this`.
    function (this: unknown, key, value) {
      const parent = this as { type?: unknown } | undefined
      if (key === 'data' && parent?.type === 'base64') return undefined
      return value
    },
  )
  const inputTokens = roughTokenCountEstimation(countable)

  return new Response(JSON.stringify({ input_tokens: inputTokens }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Wraps a fetch so `/v1/messages/count_tokens` is answered locally and every
 * other request passes straight through to `inner`.
 *
 * @param inner - The fetch to delegate non-count_tokens requests to
 * @returns A fetch suitable for the Anthropic SDK's `fetch` option
 */
export function createCountTokensShim(
  inner: FetchFn = globalThis.fetch,
): FetchFn {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      // Not an absolute URL, so not the count_tokens endpoint.
      return inner(input, init)
    }
    if (!pathname.endsWith('/v1/messages/count_tokens')) {
      return inner(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch (err) {
      // The SDK always sends a well-formed count_tokens body, so a failure here
      // means a truncated/aborted stream or a genuine bug — not a normal path.
      // Log it (the estimate for an empty body would be near-zero and could
      // skew compaction) but still return a response so the session survives.
      logError(err)
      anthropicBody = {}
    }

    return estimateTokenCountResponse(anthropicBody)
  }
}
