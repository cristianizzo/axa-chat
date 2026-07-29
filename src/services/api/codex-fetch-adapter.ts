/**
 * Codex Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to
 * ChatGPT's Codex backend API, translating between Anthropic Messages API
 * format and OpenAI Responses API format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → instructions
 * - Tool definitions (Anthropic input_schema → OpenAI parameters)
 * - Tool use (tool_use → function_call, tool_result → function_call_output)
 * - Streaming events translation
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 */

import { getCodexOAuthTokens, saveCodexOAuthTokens } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from '../../utils/model/codexModels.js'

/**
 * Resolves the model ID to send to the Codex backend.
 *
 * Claude model names are heuristically mapped to a comparable Codex model —
 * this is the legitimate case where the user is in Codex mode with a Claude
 * model still selected. Any other ID (i.e. an explicitly chosen `gpt-*` model)
 * is passed through untouched so that models newer than {@link CODEX_MODELS}
 * still work; the backend rejects genuinely invalid IDs.
 *
 * @param claudeModel - The currently selected model ID
 * @returns The model ID to send to Codex
 */
export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL

  const lower = claudeModel.toLowerCase()
  const mapped = lower.includes('opus')
    ? 'gpt-5.1-codex-max'
    : lower.includes('haiku')
      ? 'gpt-5.1-codex-mini'
      : lower.includes('sonnet')
        ? 'gpt-5.3-codex'
        : // Other Claude models (e.g. claude-fable-5, claude-mythos-5) have no
          // natural counterpart, but must not be forwarded verbatim — Codex
          // would reject them.
          lower.includes('claude')
          ? DEFAULT_CODEX_MODEL
          : null

  if (mapped) {
    logForDebugging(`Codex: mapped Claude model '${claudeModel}' to '${mapped}'`)
    return mapped
  }

  return claudeModel
}

/**
 * Checks if a given model string is a known Codex model.
 *
 * Used by model validation to skip the Anthropic-API round trip. Unknown
 * `gpt-*` models are still usable — they just don't get the validation
 * shortcut.
 *
 * @param model - The model string to check
 * @returns True if the model is a known Codex model, false otherwise
 */
export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

// ── JWT helpers ─────────────────────────────────────────────────────

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the account ID from a Codex JWT token.
 * @param token - The JWT token to extract the account ID from
 * @returns The account ID
 * @throws Error if the token is invalid or account ID cannot be extracted
 */
function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(atob(parts[1]))
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) throw new Error('No account ID in token')
    return accountId
  } catch {
    throw new Error('Failed to extract account ID from Codex token')
  }
}

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// ── Tool translation: Anthropic → Codex ─────────────────────────────

/**
 * Translates Anthropic tool definitions to Codex format.
 * @param anthropicTools - Array of Anthropic tool definitions
 * @returns Array of Codex-compatible tool objects
 */
function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {} },
    strict: null,
  }))
}

// ── Message translation: Anthropic → Codex input ────────────────────

/**
 * Translates Anthropic message format to Codex input format.
 * Handles text content, tool results, and image attachments.
 * @param anthropicMessages - Array of messages in Anthropic format
 * @returns Array of Codex-compatible input objects
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  // Track tool_use IDs to generate call_ids for function_call_output
  // Anthropic uses tool_use_id, Codex uses call_id
  let toolCallCounter = 0

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      codexInput.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const contentArr: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id || `call_${toolCallCounter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text
                if (c.type === 'image') return '[Image data attached]'
                return ''
              })
              .join('\n')
          }
          // The Responses API has no error flag on function_call_output, so
          // mark it inline — otherwise the model cannot tell a failed tool
          // call from a successful one and will happily build on the error
          // text as if it were a result.
          const isError = (block as { is_error?: unknown }).is_error === true
          codexInput.push({
            type: 'function_call_output',
            call_id: callId,
            output: isError ? `[tool error] ${outputText}` : outputText || '',
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentArr.push({ type: 'input_text', text: block.text })
        } else if (block.type === 'image' || block.type === 'document') {
          const source = block.source as Record<string, unknown> | null | undefined
          const imageUrl =
            source?.type === 'base64'
              ? `data:${String(source.media_type)};base64,${String(source.data)}`
              : source?.type === 'url' && typeof source.url === 'string'
                ? source.url
                : null
          if (imageUrl && block.type === 'image') {
            contentArr.push({ type: 'input_image', image_url: imageUrl })
          } else if (imageUrl && source?.type === 'base64') {
            // Codex accepts PDFs as a file input rather than an image.
            contentArr.push({
              type: 'input_file',
              filename:
                typeof (block as { title?: unknown }).title === 'string'
                  ? String((block as { title?: unknown }).title)
                  : 'document.pdf',
              file_data: imageUrl,
            })
          } else {
            // Nothing sensible to send. Say so in the transcript rather than
            // dropping it: the model would otherwise answer confidently about
            // an attachment it never received.
            contentArr.push({
              type: 'input_text',
              text: `[unsupported ${block.type} attachment omitted]`,
            })
            logForDebugging(
              `Codex: dropped unsupported ${block.type} block (source type ${String(source?.type)})`,
              { level: 'warn' },
            )
          }
        } else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') {
          logForDebugging(`Codex: dropped unsupported user content block '${String(block.type)}'`, {
            level: 'warn',
          })
        }
      }
      if (contentArr.length > 0) {
        if (contentArr.length === 1 && contentArr[0].type === 'input_text') {
          codexInput.push({ role: 'user', content: contentArr[0].text })
        } else {
          codexInput.push({ role: 'user', content: contentArr })
        }
      }
    } else {
      // Process assistant or tool blocks
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (msg.role === 'assistant') {
            codexInput.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: block.text, annotations: [] }],
              status: 'completed',
            })
          }
        } else if (block.type === 'tool_use') {
          const callId = block.id || `call_${toolCallCounter++}`
          codexInput.push({
            type: 'function_call',
            call_id: callId,
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          })
        }
      }
    }
  }

  return codexInput
}

// ── Full request translation ────────────────────────────────────────

/**
 * Translates a complete Anthropic API request body to Codex format.
 * @param anthropicBody - The Anthropic request body to translate
 * @returns Object containing the translated Codex body and model
 */
function translateToCodexBody(anthropicBody: Record<string, unknown>): {
  codexBody: Record<string, unknown>
  codexModel: string
} {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]

  const codexModel = mapClaudeModelToCodex(claudeModel)

  // Build system instructions
  let instructions = ''
  if (systemPrompt) {
    instructions =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text!)
              .join('\n')
          : ''
  }

  // Convert messages
  const input = translateMessages(anthropicMessages)

  // Always stream upstream: Codex is streaming-native and the non-streaming
  // Anthropic response is reconstructed from the stream by the caller.
  const codexBody: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
  }

  // Add tools if present
  if (anthropicTools.length > 0) {
    codexBody.tools = translateTools(anthropicTools)
  }

  // Anthropic caps output with max_tokens; the Responses API uses
  // max_output_tokens. Without this the model ignores the caller's limit.
  const maxTokens = anthropicBody.max_tokens
  if (typeof maxTokens === 'number') {
    codexBody.max_output_tokens = maxTokens
  }

  if (typeof anthropicBody.temperature === 'number') {
    codexBody.temperature = anthropicBody.temperature
  }

  const reasoningEffort = resolveReasoningEffort(anthropicBody)
  if (reasoningEffort) {
    codexBody.reasoning = { effort: reasoningEffort }
  }

  // Deliberately not forwarded: `cache_control` (Anthropic prompt caching has
  // no Responses API equivalent and unknown fields are rejected) and
  // `metadata` (Anthropic-specific shape).

  return { codexBody, codexModel }
}

type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Derives a Codex reasoning effort from an Anthropic request.
 *
 * `output_config.effort` — the user's `/effort` choice — is the only signal.
 * The `thinking` field is deliberately not consulted: `modelSupportsThinking()`
 * is false for every model under the `openai` provider, so a Codex request
 * never carries one.
 *
 * @param anthropicBody - The parsed Anthropic request body
 * @returns A Codex reasoning effort level, or null to let Codex decide
 */
function resolveReasoningEffort(
  anthropicBody: Record<string, unknown>,
): CodexReasoningEffort | null {
  const outputConfig = anthropicBody.output_config as
    | { effort?: unknown }
    | undefined
  const effort = outputConfig?.effort
  if (typeof effort === 'string') {
    // Anthropic's top level is 'max'; the Codex equivalent is 'xhigh'.
    if (effort === 'max') return 'xhigh'
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      return effort
    }
  }

  return null
}

// ── Response translation: Codex SSE → Anthropic SSE ─────────────────

/**
 * Formats data as Server-Sent Events (SSE) format.
 * @param event - The event type
 * @param data - The data payload
 * @returns Formatted SSE string
 */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * Translates Codex streaming response to Anthropic format.
 * Converts Codex SSE events into Anthropic-compatible streaming events.
 * @param codexResponse - The streaming response from Codex API
 * @param codexModel - The Codex model used for the request
 * @returns Transformed Response object with Anthropic-format stream
 */
/** Refresh this long before expiry, so a token cannot lapse mid-request. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** In-flight refresh, shared so concurrent requests do not each refresh. */
let codexRefreshInFlight: Promise<string> | null = null

/**
 * Returns a currently-valid Codex access token, refreshing it near expiry.
 *
 * Codex access tokens last about an hour and nothing else refreshes them: the
 * SDK's 401 handler only knows about Anthropic's credentials, so it would
 * refresh the wrong provider. Without this a session simply starts returning
 * 401s partway through and never recovers.
 *
 * `refreshCodexToken` is imported dynamically to keep the OAuth client — and
 * its analytics and browser dependencies — out of this module's import graph,
 * which is loaded on every request.
 *
 * @param fallback - The token captured when the adapter was created
 * @returns An access token to send to Codex
 */
async function getFreshCodexToken(fallback: string): Promise<string> {
  const tokens = getCodexOAuthTokens()
  if (!tokens) return fallback
  if (tokens.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return tokens.accessToken

  if (!codexRefreshInFlight) {
    codexRefreshInFlight = (async () => {
      // Re-read: another request may have refreshed while this one waited.
      const latest = getCodexOAuthTokens() ?? tokens
      if (latest.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return latest.accessToken

      const { refreshCodexToken } = await import('../oauth/codex-client.js')
      const refreshed = await refreshCodexToken(latest.refreshToken)
      saveCodexOAuthTokens(refreshed)
      logForDebugging('Codex: refreshed access token')
      return refreshed.accessToken
    })().finally(() => {
      codexRefreshInFlight = null
    })
  }

  try {
    return await codexRefreshInFlight
  } catch (e) {
    // Send the stale token anyway: the 401 that follows carries a clearer
    // message than anything synthesised here, and re-login is the only real
    // remedy either way.
    logForDebugging(`Codex: token refresh failed, using existing token: ${String(e)}`, {
      level: 'error',
    })
    return tokens.accessToken
  }
}

/**
 * Maps an HTTP status onto the Anthropic error `type` the SDK expects.
 *
 * The SDK and the retry layer branch on this string, so reporting everything
 * as `api_error` made an expired token look like a transient server fault —
 * retried several times, then surfaced without the "log in again" hint.
 *
 * @param status - The upstream HTTP status code
 * @returns The matching Anthropic error type
 */
function anthropicErrorType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limit_error'
    case 529:
      return 'overloaded_error'
    default:
      return 'api_error'
  }
}

/**
 * Pulls a human-readable message out of a Codex `response.failed` / `error`
 * event. The Responses API is inconsistent about where it puts this, so try
 * each known shape before falling back to the raw event type.
 *
 * @param event - The parsed SSE event
 * @returns A message suitable for showing to the user
 */
function describeStreamError(event: Record<string, unknown>): string {
  const response = event.response as { error?: { message?: unknown } } | undefined
  const candidates = [
    response?.error?.message,
    (event.error as { message?: unknown } | undefined)?.message,
    event.message,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return String(event.type ?? 'unknown error')
}

async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const messageId = `msg_codex_${Date.now()}`
  const encoder = new TextEncoder()

  // ── Backpressure plumbing ────────────────────────────────────────────
  // The pump fills `pendingBuffer`; the stream's pull() drains it when the
  // consumer is ready. A ReadableStream never calls pull() until start()
  // settles, so start() launches the pump without awaiting it — otherwise
  // pull() would not fire until the entire upstream response had been read
  // and the buffer would grow unbounded.
  const pendingBuffer: Uint8Array[] = []
  let bufferHead = 0
  let streamController: ReadableStreamDefaultController | null = null
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let finished = false
  // Resolved once the consumer has taken everything buffered so far.
  let notifyDrained: (() => void) | null = null
  // Resolves a pending pull() once the pump produces something to deliver.
  let notifyProduced: (() => void) | null = null

  function isBuffered(): boolean {
    return bufferHead < pendingBuffer.length
  }

  function drainBuffer(): void {
    const controller = streamController
    if (!controller) return
    while (isBuffered() && controller.desiredSize !== null && controller.desiredSize > 0) {
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

  function safeEnqueue(chunk: Uint8Array): void {
    if (finished || streamController?.desiredSize === null) return // stream closed
    pendingBuffer.push(chunk)
    drainBuffer()
    notifyProduced?.()
    notifyProduced = null
  }

  /**
   * Applies backpressure to the pump: resolves once the consumer has taken
   * everything buffered so far, or immediately if the stream is finished.
   * Awaiting this between upstream chunks is what stops a fast Codex response
   * from accumulating in memory ahead of a slow reader.
   */
  async function waitForDrain(): Promise<void> {
    if (finished || !isBuffered()) return
    await new Promise<void>(resolve => {
      notifyDrained = resolve
    })
  }

  /** Wakes both waiters — used when the stream ends or is cancelled. */
  function releaseWaiters(): void {
    notifyDrained?.()
    notifyDrained = null
    notifyProduced?.()
    notifyProduced = null
  }

  const readable = new ReadableStream({
    start(controller) {
      streamController = controller
      void pump()
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
      releaseWaiters()
      try {
        await upstreamReader?.cancel(reason)
      } catch {
        // The reader may already be released or errored — nothing to undo.
      }
    },
  })

  async function pump(): Promise<void> {
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0

      // Emit Anthropic message_start
      safeEnqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: codexModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          ),
        ),
      )

      // Emit ping
      safeEnqueue(
        encoder.encode(
          formatSSE('ping', JSON.stringify({ type: 'ping' })),
        ),
      )

      // Track state for tool calls
      let currentTextBlockStarted = false
      let currentToolCallId = ''
      let currentToolCallName = ''
      let currentToolCallArgs = ''
      let inToolCall = false
      let hadToolCalls = false
      let inReasoningBlock = false
      let streamErrored = false
      let stopReasonOverride: string | null = null
      // Whether the current tool call's arguments have already been streamed
      // as input_json_delta events.
      let toolArgsDeltaSent = false

      /**
       * Emits the tool call's arguments as a single delta when Codex supplied
       * them whole (on `output_item.added` or `function_call_arguments.done`)
       * rather than streaming them. Without this the consumer — streaming SDK
       * or aggregateStreamToMessage — reconstructs an empty tool input.
       */
      function flushToolArgs(): void {
        if (toolArgsDeltaSent || !currentToolCallArgs) return
        safeEnqueue(
          encoder.encode(
            formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: currentToolCallArgs,
              },
            })),
          ),
        )
        toolArgsDeltaSent = true
      }

      const reader = codexResponse.body?.getReader()
      if (!reader) {
        emitTextBlock(safeEnqueue, encoder, contentBlockIndex, 'Error: No response body')
        await finishStream({
          outputTokens,
          inputTokens,
          hadToolCalls: false,
          errored: true,
        })
        return
      }
      upstreamReader = reader

      try {
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          // Hold off on reading more from Codex until the consumer has taken
          // what we already translated.
          await waitForDrain()
          if (finished) break

          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            // Parse "event: xxx" lines
            if (trimmed.startsWith('event: ')) continue

            if (!trimmed.startsWith('data: ')) continue
            const dataStr = trimmed.slice(6)
            if (dataStr === '[DONE]') continue

            let event: Record<string, unknown>
            try {
              event = JSON.parse(dataStr)
            } catch (e) {
              try { logForDebugging(`Codex SSE: malformed JSON event (${dataStr.length} chars): ${String(e)}`, { level: 'debug' }) } catch {}
              continue
            }

            const eventType = event.type as string

            // ── Text output events ──────────────────────────────
            if (eventType === 'response.output_item.added') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'reasoning') {
                inReasoningBlock = true
                safeEnqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_start',
                      JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: { type: 'thinking', thinking: '' },
                      }),
                    ),
                  ),
                )
              } else if (item?.type === 'message') {
                // New text message block starting
                if (inToolCall) {
                  // Close the previous tool call block
                  flushToolArgs()
                  closeToolCallBlock(safeEnqueue, encoder, contentBlockIndex)
                  contentBlockIndex++
                  inToolCall = false
                }
              } else if (item?.type === 'function_call') {
                // Close text block if open
                if (currentTextBlockStarted) {
                  safeEnqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  currentTextBlockStarted = false
                }

                // Start tool_use block (Anthropic format)
                currentToolCallId = (item.call_id as string) || `toolu_${Date.now()}`
                currentToolCallName = (item.name as string) || ''
                currentToolCallArgs = (item.arguments as string) || ''
                toolArgsDeltaSent = false
                inToolCall = true
                hadToolCalls = true

                safeEnqueue(
                  encoder.encode(
                    formatSSE('content_block_start', JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: currentToolCallId,
                        name: currentToolCallName,
                        input: {},
                      },
                    })),
                  ),
                )
              }
            }

            // Text deltas
            else if (eventType === 'response.output_text.delta') {
              const text = event.delta as string
              if (typeof text === 'string' && text.length > 0) {
                if (!currentTextBlockStarted) {
                  // Start a new text content block
                  safeEnqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: { type: 'text', text: '' },
                      })),
                    ),
                  )
                  currentTextBlockStarted = true
                }
                safeEnqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'text_delta', text },
                    })),
                  ),
                )
                outputTokens += 1
              }
            }
            
            // Reasoning deltas
            else if (eventType === 'response.reasoning.delta') {
              const text = event.delta as string
              if (typeof text === 'string' && text.length > 0) {
                if (!inReasoningBlock) {
                  inReasoningBlock = true
                  safeEnqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: { type: 'thinking', thinking: '' },
                      })),
                    ),
                  )
                }
                safeEnqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'thinking_delta', thinking: text },
                    })),
                  ),
                )
                outputTokens += 1 // approximate token counts
              }
            }

            // ── Tool call argument deltas ───────────────────────
            else if (eventType === 'response.function_call_arguments.delta') {
              const argDelta = event.delta as string
              if (typeof argDelta === 'string' && inToolCall) {
                currentToolCallArgs += argDelta
                toolArgsDeltaSent = true
                safeEnqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: argDelta,
                      },
                    })),
                  ),
                )
              }
            }

            // Tool call arguments complete
            else if (eventType === 'response.function_call_arguments.done') {
              if (inToolCall) {
                currentToolCallArgs = (event.arguments as string) || currentToolCallArgs
              }
            }

            // Output item done — close blocks
            else if (eventType === 'response.output_item.done') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'function_call') {
                flushToolArgs()
                closeToolCallBlock(safeEnqueue, encoder, contentBlockIndex)
                contentBlockIndex++
                inToolCall = false
                currentToolCallArgs = ''
              } else if (item?.type === 'message') {
                if (currentTextBlockStarted) {
                  safeEnqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  currentTextBlockStarted = false
                }
              } else if (item?.type === 'reasoning') {
                if (inReasoningBlock) {
                  safeEnqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  inReasoningBlock = false
                }
              }
            }

            // Response completed — extract usage
            else if (eventType === 'response.completed') {
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as Record<string, number> | undefined
              if (usage) {
                outputTokens = usage.output_tokens || outputTokens
                inputTokens = usage.input_tokens || inputTokens
              }
            }

            // Upstream reported a failure. Throwing routes it through the
            // catch below, which closes any open block and surfaces the text
            // to the user. Falling through instead would end the turn with
            // stop_reason 'end_turn' — presenting a failure as a finished
            // answer, which is the worst possible outcome here.
            else if (eventType === 'response.failed' || eventType === 'error') {
              throw new Error(`Codex stream failed: ${describeStreamError(event)}`)
            }

            // Codex stopped early, normally because max_output_tokens was
            // reached. Anthropic expresses that as stop_reason 'max_tokens',
            // which the CLI already surfaces as a truncation warning; without
            // this the turn looks like it ended by choice.
            else if (eventType === 'response.incomplete') {
              const response = event.response as Record<string, unknown> | undefined
              const usage = response?.usage as Record<string, number> | undefined
              if (usage) {
                outputTokens = usage.output_tokens || outputTokens
                inputTokens = usage.input_tokens || inputTokens
              }
              const reason = (response?.incomplete_details as { reason?: string } | undefined)
                ?.reason
              stopReasonOverride = reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn'
            }
          }
        }
      } catch (err) {
        streamErrored = true
        const errorText = `\n\n[Error: ${String(err)}]`
        if (currentTextBlockStarted) {
          // A text block already owns this index — append the error to it and
          // let the close-out below emit its content_block_stop.
          safeEnqueue(
            encoder.encode(
              formatSSE('content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: errorText },
              })),
            ),
          )
        } else {
          // A tool_use or thinking block may own this index. Close it first and
          // report the error in a block of its own: reusing the index would
          // emit two content_block_starts for one block, which no Anthropic
          // client can parse.
          if (inToolCall) {
            flushToolArgs()
            closeToolCallBlock(safeEnqueue, encoder, contentBlockIndex)
            inToolCall = false
            contentBlockIndex++
          } else if (inReasoningBlock) {
            safeEnqueue(
              encoder.encode(
                formatSSE('content_block_stop', JSON.stringify({
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                })),
              ),
            )
            inReasoningBlock = false
            contentBlockIndex++
          }
          emitTextBlock(safeEnqueue, encoder, contentBlockIndex, errorText)
        }
      } finally {
        reader.releaseLock()
        upstreamReader = null
      }

      // Close any remaining open blocks
      if (currentTextBlockStarted) {
        safeEnqueue(
          encoder.encode(
            formatSSE('content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex,
            })),
          ),
        )
      }
      if (inReasoningBlock) {
        safeEnqueue(
          encoder.encode(
            formatSSE('content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex,
            })),
          ),
        )
      }
      if (inToolCall) {
        flushToolArgs()
        closeToolCallBlock(safeEnqueue, encoder, contentBlockIndex)
      }

      await finishStream({
        outputTokens,
        inputTokens,
        hadToolCalls,
        errored: streamErrored,
        stopReasonOverride,
      })
  }

  // These take the caller's buffered `enqueue` rather than the controller:
  // enqueueing directly would bypass the backpressure buffer and let these
  // events overtake still-buffered ones, emitting e.g. a content_block_stop
  // before its content_block_start.
  function closeToolCallBlock(
    enqueue: (chunk: Uint8Array) => void,
    encoder: TextEncoder,
    index: number,
  ) {
    enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index,
        })),
      ),
    )
  }

  function emitTextBlock(
    enqueue: (chunk: Uint8Array) => void,
    encoder: TextEncoder,
    index: number,
    text: string,
  ) {
    enqueue(
      encoder.encode(
        formatSSE('content_block_start', JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        })),
      ),
    )
    enqueue(
      encoder.encode(
        formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        })),
      ),
    )
    enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index,
        })),
      ),
    )
  }

  async function finishStream(opts: {
    outputTokens: number
    inputTokens: number
    hadToolCalls: boolean
    errored: boolean
    stopReasonOverride?: string | null
  }): Promise<void> {
    const { outputTokens, inputTokens, hadToolCalls, errored } = opts
    // Use 'tool_use' stop reason when the model made tool calls — but never
    // after an error: the open tool call was closed with whatever arguments
    // had arrived, and reporting 'tool_use' would make the client execute a
    // truncated call. An explicit override (e.g. 'max_tokens' from
    // response.incomplete) wins over both.
    const stopReason =
      opts.stopReasonOverride ?? (hadToolCalls && !errored ? 'tool_use' : 'end_turn')

    safeEnqueue(
      encoder.encode(
        formatSSE(
          'message_delta',
          JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            // input_tokens belongs here, not only on message_stop: the CLI
            // accumulates usage from message_start and message_delta and
            // ignores message_stop, so omitting it reports every Codex turn
            // as costing zero input tokens — which also skews compaction.
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        ),
      ),
    )
    safeEnqueue(
      encoder.encode(
        formatSSE(
          'message_stop',
          JSON.stringify({
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: inputTokens,
              outputTokenCount: outputTokens,
              invocationLatency: 0,
              firstByteLatency: 0,
            },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        ),
      ),
    )

    // Wait for the consumer to take the trailing events before closing;
    // closing with chunks still buffered would truncate the response.
    await waitForDrain()
    if (finished) return // cancelled while draining
    finished = true
    releaseWaiters()
    streamController?.close()
  }

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

// ── Non-streaming + token counting ──────────────────────────────────

/**
 * Builds an Anthropic-shaped `count_tokens` response from a local estimate.
 *
 * Codex has no token-counting endpoint. Rather than issue a real generation
 * request (the previous behaviour, which also returned SSE where the SDK
 * expected JSON), estimate from the serialised prompt.
 *
 * `roughTokenCountEstimation` is imported dynamically because
 * `tokenEstimation.ts` imports `client.ts`, which imports this module — a
 * static import would close that cycle at module-evaluation time.
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
    // object being a base64 `source` (per the Anthropic content-block schema)
    // rather than on the key name alone, so a tool input with its own `data`
    // field is still counted. Needs `function` for `this`.
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
 * Collapses an Anthropic SSE stream into a single Anthropic Message response.
 *
 * Re-parsing our own translated stream (rather than translating the Codex
 * response a second, non-streaming way) keeps one translation path, so the
 * streaming and non-streaming results cannot drift apart.
 *
 * @param streamResponse - An Anthropic-format SSE Response
 * @param codexModel - The Codex model used, echoed back in the message
 * @returns A Response containing a complete Anthropic Message JSON
 */
async function aggregateStreamToMessage(
  streamResponse: Response,
  codexModel: string,
): Promise<Response> {
  const message: Record<string, unknown> = {
    id: `msg_codex_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: codexModel,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
  const blocks: AnthropicContentBlock[] = []
  // Accumulates partial tool-call JSON, which arrives as input_json_delta
  // fragments and is only parseable once the block is complete.
  const partialJson = new Map<number, string>()
  const malformedToolCalls: string[] = []

  for await (const { event, data } of iterateSSE(streamResponse)) {
    switch (event) {
      case 'message_start': {
        const startMessage = data.message as Record<string, unknown> | undefined
        if (startMessage?.id) message.id = startMessage.id
        if (startMessage?.usage) message.usage = startMessage.usage
        break
      }
      case 'content_block_start': {
        const index = data.index as number
        blocks[index] = { ...(data.content_block as AnthropicContentBlock) }
        if (blocks[index]?.type === 'tool_use') partialJson.set(index, '')
        break
      }
      case 'content_block_delta': {
        const index = data.index as number
        const delta = data.delta as Record<string, unknown>
        const block = blocks[index]
        if (!block) break
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + String(delta.text ?? '')
        } else if (delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
        } else if (delta.type === 'input_json_delta') {
          partialJson.set(index, (partialJson.get(index) ?? '') + String(delta.partial_json ?? ''))
        }
        break
      }
      case 'content_block_stop': {
        const index = data.index as number
        const block = blocks[index]
        const json = partialJson.get(index)
        if (block && json !== undefined) {
          try {
            block.input = json ? JSON.parse(json) : {}
          } catch {
            // Leaving `input` empty would run the tool with no arguments —
            // a delete or a write with a blank target is far worse than a
            // failed turn. Replace the call with a visible message instead.
            logForDebugging(
              `Codex: failed to parse tool input JSON for block ${index}`,
              { level: 'warn' },
            )
            malformedToolCalls.push(String(block.name ?? 'unknown'))
            blocks[index] = {
              type: 'text',
              text: `[Codex returned an unparseable argument list for tool '${String(
                block.name ?? 'unknown',
              )}'; the call was not made.]`,
            } as AnthropicContentBlock
          }
        }
        break
      }
      case 'message_delta': {
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) message.stop_reason = delta.stop_reason
        if (delta?.stop_sequence !== undefined) message.stop_sequence = delta.stop_sequence
        if (data.usage) {
          message.usage = { ...(message.usage as object), ...(data.usage as object) }
        }
        break
      }
      // message_delta carries only output_tokens; message_stop is the only
      // frame with the real input_tokens.
      case 'message_stop': {
        if (data.usage) {
          message.usage = { ...(message.usage as object), ...(data.usage as object) }
        }
        break
      }
    }
  }

  message.content = blocks.filter(Boolean)

  // With the malformed call removed there may be no tool_use left, so a
  // 'tool_use' stop reason would leave the caller waiting for a tool result
  // that can never arrive.
  if (
    malformedToolCalls.length > 0 &&
    !(message.content as AnthropicContentBlock[]).some(b => b.type === 'tool_use')
  ) {
    message.stop_reason = 'end_turn'
  }

  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Parses an SSE response body into `{ event, data }` pairs.
 *
 * @param response - A Response whose body is an SSE stream
 * @yields Each event name paired with its parsed JSON payload
 */
async function* iterateSSE(
  response: Response,
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line.
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        let eventName = ''
        let dataText = ''
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) dataText += line.slice(5).trim()
        }
        if (!eventName || !dataText) continue
        try {
          yield { event: eventName, data: JSON.parse(dataText) }
        } catch {
          logForDebugging(`Codex: failed to parse SSE frame for '${eventName}'`, {
            level: 'warn',
          })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Main fetch interceptor ──────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses'

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to Codex.
 * @param accessToken - The Codex access token for authentication
 * @returns A fetch function that translates Anthropic requests to Codex format
 */
export function createCodexFetch(
  accessToken: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const accountId = extractAccountId(accessToken)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept the message-creation endpoint. Note `/v1/messages` is a
    // prefix of `/v1/messages/count_tokens`, which must NOT be translated into
    // a full Responses call — it's handled separately below.
    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      // Not an absolute URL, so not something we route to Codex.
      return globalThis.fetch(input, init)
    }
    const isCountTokens = pathname.endsWith('/v1/messages/count_tokens')
    const isMessages = pathname.endsWith('/v1/messages')
    if (!isMessages && !isCountTokens) {
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch (e) {
      try { logForDebugging(`Codex: failed to parse request body: ${String(e)}`, { level: 'warn' }) } catch {}
      return new Response(JSON.stringify({ error: { message: 'Failed to parse request body', type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Codex exposes no token-counting endpoint, so answer locally rather than
    // billing a full generation request to find out how long a prompt is.
    if (isCountTokens) {
      return estimateTokenCountResponse(anthropicBody)
    }

    const currentToken = await getFreshCodexToken(accessToken)

    // Translate to Codex format
    const { codexBody, codexModel } = translateToCodexBody(anthropicBody)

    // Call Codex API
    const codexResponse = await globalThis.fetch(CODEX_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${currentToken}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'OpenAI-Beta': 'responses=experimental',
      },
      body: JSON.stringify(codexBody),
      // Forward the SDK's abort signal so timeouts and Ctrl-C can cancel the
      // upstream request — otherwise the non-streaming path, which blocks
      // until the stream ends, cannot be interrupted.
      ...(init?.signal && { signal: init.signal }),
    })

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text()
      const errorBody = {
        type: 'error',
        error: {
          type: anthropicErrorType(codexResponse.status),
          message: `Codex API error (${codexResponse.status}): ${errorText}`,
        },
      }
      // Carry the upstream headers over. `Retry-After` and the rate-limit
      // headers drive backoff, the fast-mode cooldown and the overage check;
      // dropping them made every 429 look like it had no retry hint, which
      // silently turned a short pause into a long one.
      const headers = new Headers(codexResponse.headers)
      headers.set('Content-Type', 'application/json')
      headers.delete('Content-Encoding')
      headers.delete('Content-Length')
      return new Response(JSON.stringify(errorBody), {
        status: codexResponse.status,
        headers,
      })
    }

    // Translate streaming response. Codex is always streamed upstream, so when
    // the caller asked for a non-streaming response we collapse the translated
    // events back into a single Anthropic Message.
    const anthropicStream = await translateCodexStreamToAnthropic(codexResponse, codexModel)
    return anthropicBody.stream === true
      ? anthropicStream
      : aggregateStreamToMessage(anthropicStream, codexModel)
  }
}
