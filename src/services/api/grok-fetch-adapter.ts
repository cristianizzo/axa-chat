/**
 * Grok Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to x.ai's
 * OpenAI-compatible Chat Completions API, translating between Anthropic Messages
 * API format and OpenAI Chat Completions format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → system role message
 * - Tool definitions (Anthropic input_schema → OpenAI function parameters)
 * - Tool use (tool_use → function call, tool_result → tool role message)
 * - Streaming events translation (OpenAI SSE → Anthropic SSE)
 * - Grok reasoning_content → thinking content blocks
 * - Image input (Anthropic image blocks → OpenAI image_url parts)
 *
 * Endpoint: https://api.x.ai/v1/chat/completions
 */

import { GROK_BASE_URL, GROK_MAX_OUTPUT_TOKENS, GROK_MESSAGES_PATH, DEFAULT_GROK_MODEL } from '../../config/grok.js'
import { logForDebugging } from '../../utils/debug.js'
import { estimateTokenCountResponse } from './count-tokens-shim.js'
import { createBackpressuredSseStream } from './sse-backpressure.js'
import { logError } from '../../utils/log.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

// 1 MiB per SSE line — a legitimate response never approaches this
const MAX_SSE_LINE_BYTES = 1_048_576

// How much of a non-SSE 200 body to keep for the error log. Enough for an API
// error envelope, small enough that it cannot itself become the problem.
const RAW_PREFIX_LIMIT = 500

// The only finish_reasons this adapter knows how to surface. Anything else the
// upstream reports — content_filter, a future value — means it stopped for a
// reason we would otherwise map to a clean end_turn, so it is treated as a
// truncated or refused answer and fails loudly.
const MODELLED_FINISH_REASONS = ['stop', 'tool_calls', 'length']

// ── Types ────────────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  thinking?: string
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

interface OpenAIMessage {
  role: string
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// ── Tool translation: Anthropic → OpenAI ─────────────────────────────────────

function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

// ── Message translation: Anthropic → OpenAI ──────────────────────────────────

/**
 * Converts an Anthropic message array to OpenAI Chat Completions messages.
 *
 * Key differences handled:
 * - Anthropic `tool_use` in assistant messages → OpenAI `tool_calls`
 * - Anthropic `tool_result` in user messages → OpenAI `tool` role messages
 * - Multi-block content arrays → concatenated text where possible
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []

      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? `call_${Date.now()}`,
            type: 'function',
            function: {
              name: block.name ?? '',
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
        // thinking/redacted_thinking blocks are skipped — Grok handles its own reasoning
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('') || null,
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    } else if (msg.role === 'user') {
      // Tool results must become separate `tool` role messages in OpenAI format
      const contentParts: Array<Record<string, unknown>> = []
      const toolResults: OpenAIMessage[] = []
      let hasImage = false

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .filter(c => c.type === 'text')
              .map(c => c.text ?? '')
              .join('\n')
          }
          const isError = (block as { is_error?: unknown }).is_error === true
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content: isError ? `[tool error] ${outputText}` : outputText,
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentParts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined
          if (source?.type === 'base64' && source.media_type && source.data) {
            contentParts.push({ type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } })
            hasImage = true
          } else if (source?.type === 'url' && source.url) {
            contentParts.push({ type: 'image_url', image_url: { url: source.url } })
            hasImage = true
          } else {
            logForDebugging(`Grok translateMessages: image block with unrecognised source type '${source?.type}'`, { level: 'warn' })
            contentParts.push({ type: 'text', text: `[Unsupported ${block.type} attachment omitted from this request.]` })
          }
        } else {
          logForDebugging(`Grok translateMessages: unsupported block type '${block.type}' omitted`, { level: 'warn' })
          contentParts.push({ type: 'text', text: `[Unsupported ${block.type} attachment omitted from this request.]` })
        }
      }

      // Tool results first (they logically precede the next user message)
      result.push(...toolResults)

      if (contentParts.length > 0) {
        if (hasImage) {
          // OpenAI requires array content when images are present
          result.push({ role: 'user', content: contentParts })
        } else {
          // Plain string for the common text-only path
          const text = contentParts.map(p => (p as { text?: string }).text ?? '').join('')
          result.push({ role: 'user', content: text })
        }
      }
    }
  }

  return result
}

// ── Full request translation ──────────────────────────────────────────────────

function translateToOpenAIBody(anthropicBody: Record<string, unknown>): Record<string, unknown> {
  const messages = (anthropicBody.messages ?? []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string }>
    | undefined

  let system: string | undefined
  if (typeof systemPrompt === 'string') {
    system = systemPrompt
  } else if (Array.isArray(systemPrompt)) {
    system = systemPrompt
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n') || undefined
  }

  const model = resolveModel(anthropicBody.model as string | undefined)
  const openAIMessages = translateMessages(messages, system)
  const anthropicTools = (anthropicBody.tools ?? []) as AnthropicTool[]

  const body: Record<string, unknown> = {
    model,
    messages: openAIMessages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (typeof anthropicBody.max_tokens === 'number') {
    // Clamp to Grok's hard cap so an escalated Claude-sized request can
    // never exceed what the API will accept.
    body.max_tokens = Math.min(anthropicBody.max_tokens, GROK_MAX_OUTPUT_TOKENS.upperLimit)
  }

  if (typeof anthropicBody.temperature === 'number') {
    body.temperature = anthropicBody.temperature
  }

  if (Array.isArray(anthropicBody.stop_sequences)) {
    // Anthropic stop_sequences → OpenAI stop. Without this the sequences were
    // dropped, so a caller that asks the model to stop at a marker (e.g.
    // yoloClassifier's '</block>') had the model run straight past it and
    // parse text it was promised would never appear. Filtered to strings —
    // `stop_sequences` arrives untyped on this Record, and a non-string entry
    // would draw a provider 400.
    const sequences = anthropicBody.stop_sequences.filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
    if (sequences.length > 0) body.stop = sequences
  }

  if (typeof anthropicBody.output_config === 'object' && anthropicBody.output_config !== null) {
    // Anthropic structured outputs → OpenAI response_format. Anthropic sends
    // output_config.format as { type:'json_schema', schema }, and the schema
    // carries no name — which x.ai accepts (probe-verified against grok-4.6).
    const format = (anthropicBody.output_config as { format?: unknown }).format as
      | { type?: string; schema?: unknown }
      | undefined
    if (format?.type === 'json_schema' && format.schema && typeof format.schema === 'object') {
      body.response_format = { type: 'json_schema', json_schema: { schema: format.schema } }
    }
  }

  if (anthropicTools.length > 0) {
    body.tools = translateTools(anthropicTools)
    // Translate Anthropic tool_choice → OpenAI tool_choice
    const tc = anthropicBody.tool_choice as { type?: string; name?: string } | undefined
    if (tc?.type === 'any') {
      body.tool_choice = 'required'
    } else if (tc?.type === 'tool' && tc.name) {
      body.tool_choice = { type: 'function', function: { name: tc.name } }
    } else {
      body.tool_choice = 'auto'
    }
  }

  return body
}

/**
 * Maps an Anthropic model name to the appropriate Grok model.
 *
 * Every Claude family — Opus, Sonnet, Haiku, Fable, Mythos — maps to whatever
 * DEFAULT_GROK_MODEL currently names, so the flagship version lives in
 * config/grok.ts alone and this function needs no edit when it moves.
 *
 * A `grok-*` ID passes through rather than being clamped to the default. In
 * practice only the catalog's own ID can arrive here — `/model`, settings and
 * ANTHROPIC_MODEL are all filtered by isServableByActiveProvider, which defers
 * to the catalog's exact-ID acceptsModel — so the branch is a no-op today. It
 * stays permissive because the failure modes are asymmetric: if GROK_MODELS
 * gains a second entry, pass-through serves it, whereas clamping would quietly
 * answer as the wrong model with no way for the user to tell.
 */
function resolveModel(claudeModel: string | undefined): string {
  if (!claudeModel) return DEFAULT_GROK_MODEL

  const lower = claudeModel.toLowerCase()

  // Already a Grok model — pass through
  if (lower.startsWith('grok-')) return claudeModel

  // Map Claude families to the Grok flagship
  if (lower.includes('opus')) return DEFAULT_GROK_MODEL
  if (lower.includes('sonnet')) return DEFAULT_GROK_MODEL
  if (lower.includes('haiku')) return DEFAULT_GROK_MODEL
  if (lower.includes('fable')) return DEFAULT_GROK_MODEL
  if (lower.includes('mythos')) return DEFAULT_GROK_MODEL

  logForDebugging(`Grok resolveModel: unrecognised model '${claudeModel}', falling back to '${DEFAULT_GROK_MODEL}'`, { level: 'warn' })
  return DEFAULT_GROK_MODEL
}

// ── Response translation: OpenAI SSE → Anthropic SSE ─────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * Translates an OpenAI Chat Completions streaming response to Anthropic SSE format.
 *
 * OpenAI stream events look like:
 *   data: {"id":"...","choices":[{"delta":{"content":"hi"},"index":0}]}
 *
 * Grok adds:
 *   data: {"choices":[{"delta":{"reasoning_content":"...","content":null}}]}
 *
 * We map these to Anthropic's event sequence:
 *   message_start → content_block_start → content_block_delta* → content_block_stop
 *   → message_delta → message_stop
 */
async function translateOpenAIStreamToAnthropic(
  openAIResponse: Response,
  model: string,
): Promise<Response> {
  const messageId = `msg_grok_${Date.now()}`
  const encoder = new TextEncoder()

  // The pump below fills the sink; the sink hands bytes to the consumer as it
  // asks for them. See sse-backpressure.ts for why the pump is started rather
  // than awaited.
  const { readable, sink } = createBackpressuredSseStream('Grok', () =>
    pump(),
  )
  const safeEnqueue = sink.enqueue
  const waitForDrain = sink.waitForDrain

  async function pump(): Promise<void> {
    let contentBlockIndex = 0
    let inputTokens = 0
    let outputTokens = 0
    let outputChars = 0
    let usageSeen = false
    let textBlockOpen = false
    let thinkingBlockOpen = false
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let toolIdSeq = 0
    let hadToolCalls = false
    let streamErrored = false
    let aborted = false
    // The raw finish_reason, so an unrecognised value can be told apart from
    // the three this adapter models (a boolean cannot).
    let finishReasonValue: string | null = null
    let lengthTruncated = false
    let sawAnyDataLine = false

    // Emit Anthropic message_start
    safeEnqueue(encoder.encode(formatSSE('message_start', JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }))))

    safeEnqueue(encoder.encode(formatSSE('ping', JSON.stringify({ type: 'ping' }))))

    function openTextBlock(): void {
      if (textBlockOpen) return
      safeEnqueue(encoder.encode(formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'text', text: '' },
      }))))
      textBlockOpen = true
    }

    function closeTextBlock(): void {
      if (!textBlockOpen) return
      safeEnqueue(encoder.encode(formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index: contentBlockIndex,
      }))))
      contentBlockIndex++
      textBlockOpen = false
    }

    function openThinkingBlock(): void {
      if (thinkingBlockOpen) return
      safeEnqueue(encoder.encode(formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      }))))
      thinkingBlockOpen = true
    }

    function closeThinkingBlock(): void {
      if (!thinkingBlockOpen) return
      safeEnqueue(encoder.encode(formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index: contentBlockIndex,
      }))))
      contentBlockIndex++
      thinkingBlockOpen = false
    }

    function flushToolBlocks(): void {
      if (toolCalls.size === 0) return
      for (const toolCall of toolCalls.values()) {
        safeEnqueue(encoder.encode(formatSSE('content_block_start', JSON.stringify({
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: {},
          },
        }))))
        safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'input_json_delta', partial_json: toolCall.args },
        }))))
        safeEnqueue(encoder.encode(formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: contentBlockIndex,
        }))))
        contentBlockIndex++
      }
      toolCalls.clear()
    }


    const reader = openAIResponse.body?.getReader()
    if (!reader) {
      logError(new Error('Grok: response body is null — no SSE stream received'))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Grok: response body is null — no SSE stream received' },
      }))))
      await sink.close()
      return
    }
    sink.setUpstreamReader(reader)

    let rawPreview = ''

    try {
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        await waitForDrain()
        if (sink.done) break

        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk
        if (rawPreview.length < RAW_PREFIX_LIMIT) {
          rawPreview += chunk.slice(0, RAW_PREFIX_LIMIT - rawPreview.length)
        }
        if (buffer.length > MAX_SSE_LINE_BYTES) {
          throw new Error(`Grok SSE frame exceeded ${MAX_SSE_LINE_BYTES} bytes`)
        }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          sawAnyDataLine = true
          const dataStr = trimmed.slice(6)
          if (dataStr === '[DONE]') continue

          let event: Record<string, unknown>
          try {
            event = JSON.parse(dataStr) as Record<string, unknown>
          } catch {
            // A frame that fails JSON.parse is malformed, not merely
            // unfamiliar — an unmodelled field would parse fine and be ignored
            // below. Not escalated to a stream error, because the two ways it
            // happens both end acceptably. A frame split by a dropped
            // connection also ends the stream without a finish_reason, which
            // now fails loudly. And a multi-line SSE `data` field — expressed
            // as repeated `data:` lines, so each one clears the prefix check
            // above and is parsed as its own frame — makes each line fail
            // here, losing that one event from a stream that is otherwise
            // fine. OpenAI-shaped APIs emit single-line JSON, so the second is
            // theoretical. The payload is logged because the length alone gave
            // nothing to diagnose from.
            logForDebugging(
              `Grok SSE: malformed JSON frame, skipped: ${dataStr.slice(0, 200)}`,
              { level: 'warn' },
            )
            continue
          }

          // x.ai reports a mid-generation abort (rate limit, content filter,
          // backend fault) as an OpenAI-shaped error frame on an already-200
          // stream. It carries no `choices`, so without this it would fall
          // through the delta handling below and be discarded — the user would
          // get whatever text arrived before the abort, presented as a
          // complete answer. Throw so the catch below marks the stream errored.
          const errorFrame = event.error as
            | { message?: string; type?: string; code?: string }
            | undefined
          if (errorFrame) {
            throw new Error(
              `Grok stream error: ${errorFrame.message ?? JSON.stringify(errorFrame)}`,
            )
          }

          // Usage information (may appear in the final chunk)
          const usage = event.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
          if (usage) {
            usageSeen = true
            inputTokens = usage.prompt_tokens ?? inputTokens
            outputTokens = usage.completion_tokens ?? outputTokens
          }

          const choices = event.choices as Array<{
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string | null
          }> | undefined

          if (!choices?.length) continue

          const choice = choices[0]!
          const delta = choice.delta

          if (!delta) {
            // finish_reason chunk with no delta
            if (choice.finish_reason) {
              finishReasonValue = choice.finish_reason
              if (choice.finish_reason === 'tool_calls') hadToolCalls = true
              if (choice.finish_reason === 'length') lengthTruncated = true
            }
            continue
          }

          // ── Reasoning content (Grok) ─────────────────────────────────────
          if (delta.reasoning_content) {
            closeTextBlock()
            openThinkingBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }))))
            outputChars += delta.reasoning_content.length
          }

          // ── Text content ──────────────────────────────────────────────────
          if (delta.content) {
            closeThinkingBlock()
            openTextBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }))))
            outputChars += delta.content.length
          }

          // ── Tool calls ────────────────────────────────────────────────────
          if (delta.tool_calls?.length) {
            closeThinkingBlock()
            closeTextBlock()

            for (const tc of delta.tool_calls) {
              const tcIndex = tc.index ?? 0
              const existing = toolCalls.get(tcIndex)

              if (tc.function?.name !== undefined) {
                if (existing) {
                  existing.name = tc.function.name
                } else {
                  toolCalls.set(tcIndex, {
                    id: tc.id ?? `toolu_${messageId}_${toolIdSeq++}`,
                    name: tc.function.name,
                    args: '',
                  })
                  hadToolCalls = true
                }
              }

              if (tc.function?.arguments !== undefined) {
                const toolCall = toolCalls.get(tcIndex)
                if (toolCall) {
                  toolCall.args += tc.function.arguments
                  // Counted towards the estimate too: a tool-only turn produces
                  // no text and no reasoning, so without this it would fall back
                  // to zero output tokens — the very case the estimate exists for.
                  outputChars += tc.function.arguments.length
                } else {
                  logForDebugging(
                    `Grok SSE: argument delta for unknown tool index ${tcIndex}`,
                    { level: 'warn' },
                  )
                }
              }
            }

            if (choice.finish_reason === 'tool_calls') {
              finishReasonValue = choice.finish_reason
              hadToolCalls = true
            }
          }

          // Track finish_reason even when it arrives alongside a delta (e.g. finish_reason:'stop')
          if (choice.finish_reason && !finishReasonValue) {
            finishReasonValue = choice.finish_reason
            if (choice.finish_reason === 'length') lengthTruncated = true
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        // The caller cancelled — a silent close is correct, since the SDK
        // treats abort as a clean stop and an error event would be wrong.
        // Logged at debug so an abort that was not the caller's own cancel
        // (watchdog, proxy reset surfacing as AbortError) is not entirely
        // invisible. Not logError: a genuine user cancel must not trip
        // --hard-fail.
        aborted = true
        logForDebugging('Grok SSE: stream aborted', { level: 'debug' })
      } else {
        streamErrored = true
        logError(err)
        safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Grok stream failed: ${err instanceof Error ? err.message : String(err)}` },
        }))))
      }
    } finally {
      reader.releaseLock()
      sink.setUpstreamReader(null)
    }

    // Abort or hard error: skip finishStream entirely — emitting message_delta
    // and message_stop after an error event would be incoherent.
    if (aborted || streamErrored) {
      await sink.close()
      return
    }

    // 200 response that contained no SSE data lines at all (e.g. x.ai
    // returning a plain JSON error body on an otherwise-200 response).
    if (!sawAnyDataLine) {
      const detail = rawPreview ? `: ${rawPreview}` : ''
      logError(new Error(`Grok: 200 response contained no SSE data lines${detail}`))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Grok: 200 response contained no SSE data lines${detail}` },
      }))))
      await sink.close()
      return
    }

    // A stream that ends without a finish_reason was cut off: the socket closed
    // cleanly enough that `read()` reported `done`, but x.ai never said why it
    // stopped. Deliberately not gated on contentBlockIndex — that counter only
    // advances when a block is *closed*, so the commonest truncation of all (a
    // single answer cut off mid-sentence, one text block still open, index
    // still 0) used to skip this entirely and be reported as a clean end_turn.
    //
    // Emitted as `event: error`, not as warning text in the assistant block.
    // Injecting text here finished the message as a normal end_turn, so a
    // truncated answer was indistinguishable from a complete one and the
    // warning came back the next turn as the model's own prior output.
    //
    // This surfaces as a hard turn failure, not a retry: the SDK raises
    // `APIError` with no status (the vendored `streaming.js` passes
    // `undefined` on `sse.event === 'error'`), and `shouldRetry` bails on a
    // statusless error. So the streaming path fails visibly while the
    // non-streaming 500 below is retried. Visible and unretried still beats
    // silently wrong, but the asymmetry is real.
    //
    // A completed stream always carries a finish_reason, so this cannot fire
    // on the happy path.
    if (!finishReasonValue) {
      const message = 'Grok stream ended without a finish_reason — the response was cut short'
      logError(new Error(message))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message },
      }))))
      await sink.close()
      return
    }

    // A present-but-unmodelled finish_reason means the provider stopped for a
    // reason this adapter does not surface (content_filter is a refusal;
    // anything future is unknown). Mapping it to end_turn would be the same
    // silent truncation this function exists to prevent, so it fails the same
    // loud way, with the reason named.
    if (!MODELLED_FINISH_REASONS.includes(finishReasonValue)) {
      const message = `Grok stream stopped with unhandled finish_reason '${finishReasonValue}'`
      logError(new Error(message))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message },
      }))))
      await sink.close()
      return
    }

    // Close any open blocks
    closeTextBlock()
    closeThinkingBlock()
    flushToolBlocks()

    // Estimate token count from character count when the API didn't report usage
    if (!usageSeen) {
      outputTokens = Math.ceil(outputChars / 4)
      logForDebugging('Grok SSE: no usage reported — token counts are estimated', { level: 'warn' })
    }

    await finishStream({ inputTokens, outputTokens, hadToolCalls, lengthTruncated })
  }

  async function finishStream(opts: {
    inputTokens: number
    outputTokens: number
    hadToolCalls: boolean
    lengthTruncated: boolean
  }): Promise<void> {
    const stopReason = opts.lengthTruncated
      ? 'max_tokens'
      : opts.hadToolCalls
        ? 'tool_use'
        : 'end_turn'

    safeEnqueue(encoder.encode(formatSSE('message_delta', JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    }))))

    safeEnqueue(encoder.encode(formatSSE('message_stop', JSON.stringify({
      type: 'message_stop',
      usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
    }))))

    await sink.close()
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

// ── Non-streaming response aggregation ───────────────────────────────────────

/**
 * Collapses an Anthropic SSE stream into a single Anthropic Message response.
 * Re-uses the translated stream so streaming and non-streaming paths stay in sync.
 */
async function aggregateStreamToMessage(
  streamResponse: Response,
  model: string,
): Promise<Response> {
  const message: Record<string, unknown> = {
    id: `msg_grok_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }

  const blocks: AnthropicContentBlock[] = []
  const partialJson = new Map<number, string>()
  let streamError: string | null = null

  const reader = streamResponse.body?.getReader()
  if (!reader) {
    const message = 'Grok: translated stream had no body to aggregate'
    logError(new Error(message))
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

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

        let data: Record<string, unknown>
        try {
          data = JSON.parse(dataText) as Record<string, unknown>
        } catch {
          continue
        }

        switch (eventName) {
          case 'message_start': {
            const startMsg = data.message as Record<string, unknown> | undefined
            if (startMsg?.usage) message.usage = startMsg.usage
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
              block.thinking = (block.thinking ?? '') + String(delta.thinking ?? '')
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
                const parsed = json ? JSON.parse(json) : {}
                block.input = parsed
              } catch (err) {
                logError(new Error(`Grok: unparseable tool arguments for '${String(block.name ?? 'unknown')}': ${String(err)}`))
                blocks[index] = {
                  type: 'text',
                  text: `[Grok returned an unparseable argument list for tool '${String(block.name ?? 'unknown')}'; the call was not made.]`,
                } as AnthropicContentBlock
              }
            }
            break
          }
          case 'message_delta': {
            const delta = data.delta as Record<string, unknown> | undefined
            if (delta?.stop_reason) message.stop_reason = delta.stop_reason
            if (data.usage) message.usage = { ...(message.usage as object), ...(data.usage as object) }
            break
          }
          case 'message_stop': {
            if (data.usage) message.usage = { ...(message.usage as object), ...(data.usage as object) }
            break
          }
          // The streaming path signals every failure as `event: error`. Without
          // this case the frame matched nothing and was dropped, and the caller
          // got 200 with the initialised stop_reason 'end_turn' plus whatever
          // partial content had arrived — a truncated answer indistinguishable
          // from a complete one. This path feeds sideQuery, so that answer was
          // being used to make permission decisions.
          case 'error': {
            const err = data.error as { message?: string } | undefined
            streamError = err?.message ?? 'Grok stream failed'
            break
          }
          // Keep-alive, emitted by the pump on every response. Listed
          // explicitly so it does not reach the `default` below and warn on
          // every non-streaming call.
          case 'ping':
            break
          default:
            logForDebugging(
              `Grok: unhandled Anthropic SSE event '${eventName}' while aggregating a non-streaming response`,
              { level: 'warn' },
            )
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // A non-200 is what makes the SDK raise an APIError on the non-streaming
  // path, mirroring what `event: error` does on the streaming one. 500 so the
  // SDK's own retry policy treats it as transient.
  if (streamError) {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamError } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // A tool_use stop_reason with no surviving tool_use block means the call
  // was dropped for unparseable arguments (see content_block_stop above).
  // Claiming a tool call that is not in the content would make the caller wait
  // for a tool_use block that never comes; downgrade to end_turn so the
  // message is coherent text.
  if (message.stop_reason === 'tool_use' && !blocks.some(b => b?.type === 'tool_use')) {
    message.stop_reason = 'end_turn'
  }

  message.content = blocks.filter(Boolean)
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Error translation ─────────────────────────────────────────────────────────

function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error'
    case 401: return 'authentication_error'
    case 403: return 'permission_error'
    case 404: return 'not_found_error'
    case 429: return 'rate_limit_error'
    case 529: return 'overloaded_error'
    default:  return 'api_error'
  }
}

function describeGrokError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown } | null
    const message =
      typeof parsed?.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed?.message === 'string'
          ? parsed.message
          : undefined
    return message ?? body.trim().slice(0, 300)
  } catch {
    return body.trim().slice(0, 300) || 'no response body'
  }
}

// ── Main fetch interceptor ────────────────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes them
 * to Grok's OpenAI-compatible Chat Completions API.
 *
 * @param apiKey - The Grok API key for Bearer authentication
 * @param inner - The fetch to send the translated request with, and to pass
 *   untranslated requests through to. Taking it as an argument is what lets the
 *   caller wrap Grok traffic the same way it wraps every other provider's:
 *   the concurrency limiter and the request logging live in that fetch. Proxy
 *   options do not — the outbound call below sets its own.
 * @returns A fetch suitable for the Anthropic SDK's `fetch` option
 */
export function createGrokFetch(
  apiKey: string,
  inner: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      return inner(input, init)
    }

    const isCountTokens = pathname.endsWith('/v1/messages/count_tokens')
    const isMessages = pathname.endsWith('/v1/messages')

    if (!isMessages && !isCountTokens) {
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
      anthropicBody = JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Failed to parse request body' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    if (isCountTokens) {
      return estimateTokenCountResponse(anthropicBody)
    }

    const model = resolveModel(anthropicBody.model as string | undefined)
    const openAIBody = translateToOpenAIBody(anthropicBody)

    const grokResponse = await inner(`${GROK_BASE_URL}${GROK_MESSAGES_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openAIBody),
      ...(init?.signal && { signal: init.signal }),
      ...getProxyFetchOptions({ forAnthropicAPI: false }),
    })

    if (!grokResponse.ok) {
      const errorText = await grokResponse.text()
      const errorBody = {
        type: 'error',
        error: {
          type: anthropicErrorType(grokResponse.status),
          message: `Grok API error (${grokResponse.status}): ${describeGrokError(errorText)}`,
        },
      }
      // The upstream retry directives must survive the translation, or the
      // provider's backoff is discarded. The vendored SDK reads
      // retry-after-ms and retry-after off the error Response's headers; this
      // repo's shouldRetry (getRetryAfter) reads only retry-after. Preserving
      // both covers the SDK and the repo retry loop.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      for (const name of ['retry-after-ms', 'retry-after']) {
        const value = grokResponse.headers.get(name)
        if (value) headers[name] = value
      }
      return new Response(JSON.stringify(errorBody), {
        status: grokResponse.status,
        headers,
      })
    }

    const anthropicStream = await translateOpenAIStreamToAnthropic(grokResponse, model)
    return anthropicBody.stream === true
      ? anthropicStream
      : aggregateStreamToMessage(anthropicStream, model)
  }
}
