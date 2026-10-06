/**
 * Ollama Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to a local (or
 * self-hosted) Ollama daemon's native `/api/chat` endpoint, translating between
 * Anthropic Messages API format and Ollama's own chat format.
 *
 * Mirrors deepseek-fetch-adapter.ts and grok-fetch-adapter.ts, but targets
 * Ollama's native API rather than an OpenAI-compatible one, because the
 * previously-used `/v1/messages` Anthropic-compat shim does not expose the
 * daemon's prompt/KV cache (see config/ollama.ts for the measured comparison).
 * Going native is what makes a multi-turn session fast: Ollama reuses the KV
 * cache for the shared prefix of consecutive requests, which `/v1/messages`
 * never surfaced.
 *
 * Supports:
 * - Text messages (user/assistant), system prompt → system role message
 * - Tool definitions (Anthropic input_schema → OpenAI-shaped function schema,
 *   which Ollama's native API also accepts)
 * - Tool use (tool_use → tool_calls, tool_result → tool role message)
 * - Streaming events translation (Ollama NDJSON → Anthropic SSE)
 * - Ollama `thinking` field → thinking content blocks
 * - Image input (Anthropic base64 image blocks → Ollama's `images` field)
 *
 * Endpoint: `${baseUrl}/api/chat`, where baseUrl is the stored account's own
 * daemon address — never OLLAMA_BASE_URL's default, which would ignore a
 * self-hosted account's configured address.
 */

import { OLLAMA_CHAT_PATH } from '../../config/ollama.js'
import { logForDebugging } from '../../utils/debug.js'
import { estimateTokenCountResponse } from './count-tokens-shim.js'
import { createBackpressuredSseStream } from './sse-backpressure.js'
import { logError } from '../../utils/log.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

// 1 MiB per NDJSON line — a legitimate response never approaches this.
const MAX_LINE_BYTES = 1_048_576

// How much of a non-NDJSON 200 body to keep for the error log.
const RAW_PREFIX_LIMIT = 500

// The only done_reasons this adapter knows how to surface. Ollama also reports
// 'load' and 'unload' for keep-alive-only requests, which axa never sends (every
// request carries real messages) — an unrecognised value fails loudly rather
// than being silently mapped to a clean end_turn.
const MODELLED_DONE_REASONS = ['stop', 'length']

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
  source?: { type?: string; media_type?: string; data?: string; url?: string }
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

interface OllamaMessage {
  role: string
  content: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_call_id?: string
}

interface OllamaToolCall {
  id?: string
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

// ── Tool translation: Anthropic → Ollama ─────────────────────────────────────

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

// ── Message translation: Anthropic → Ollama ──────────────────────────────────

/**
 * Converts an Anthropic message array to Ollama's native chat messages.
 *
 * Key differences from Anthropic's shape:
 * - `tool_use` blocks in an assistant message become `tool_calls`, with
 *   `arguments` as a parsed object — Ollama's native API takes the object
 *   directly, unlike OpenAI's stringified-JSON convention.
 * - `tool_result` blocks become their own `tool` role message, matched back by
 *   `tool_call_id` (verified against a live daemon: a `tool_call_id` set on the
 *   assistant's `tool_calls` entry is honoured on the following `tool` message).
 * - Image blocks move to Ollama's sibling `images` array (base64, no data: URL
 *   prefix) rather than an inline content part.
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
  systemPrompt?: string,
): OllamaMessage[] {
  const result: OllamaMessage[] = []

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
      const toolCalls: OllamaToolCall[] = []

      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            function: {
              name: block.name ?? '',
              arguments: block.input ?? {},
            },
          })
        }
        // thinking/redacted_thinking blocks are skipped — re-sending the
        // model's own prior reasoning as input is not part of Ollama's contract
        // and the daemon regenerates it fresh on every turn anyway.
      }

      const assistantMsg: OllamaMessage = { role: 'assistant', content: textParts.join('') }
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
      result.push(assistantMsg)
    } else if (msg.role === 'user') {
      const textParts: string[] = []
      const images: string[] = []
      const toolResults: OllamaMessage[] = []

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
          textParts.push(block.text)
        } else if (block.type === 'image') {
          const source = block.source
          if (source?.type === 'base64' && source.data) {
            images.push(source.data)
          } else {
            // Ollama's native API takes only inline base64, not a URL — unlike
            // the OpenAI-compat shape the Grok/DeepSeek adapters translate to.
            logForDebugging(`Ollama translateMessages: unsupported image source type '${source?.type}'`, { level: 'warn' })
            textParts.push('[Unsupported image attachment omitted from this request.]')
          }
        } else {
          logForDebugging(`Ollama translateMessages: unsupported block type '${block.type}' omitted`, { level: 'warn' })
          textParts.push(`[Unsupported ${block.type} attachment omitted from this request.]`)
        }
      }

      // Tool results first (they logically precede the next user message).
      result.push(...toolResults)

      if (textParts.length > 0 || images.length > 0) {
        const userMsg: OllamaMessage = { role: 'user', content: textParts.join('') }
        if (images.length > 0) userMsg.images = images
        result.push(userMsg)
      }
    }
  }

  return result
}

// ── Full request translation ──────────────────────────────────────────────────

function translateToOllamaBody(anthropicBody: Record<string, unknown>, model: string): Record<string, unknown> {
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

  const ollamaMessages = translateMessages(messages, system)
  const anthropicTools = (anthropicBody.tools ?? []) as AnthropicTool[]

  const options: Record<string, unknown> = {}
  if (typeof anthropicBody.max_tokens === 'number') {
    // Ollama's native parameter name; no fixed upper clamp the way Grok's
    // adapter applies one — the daemon's own context window (which varies
    // per-model from 2k to 256k locally) is the real limit, and an
    // out-of-range value surfaces as an ordinary non-200 the same as any
    // other provider error below.
    options.num_predict = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    options.temperature = anthropicBody.temperature
  }
  if (Array.isArray(anthropicBody.stop_sequences)) {
    const sequences = anthropicBody.stop_sequences.filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
    if (sequences.length > 0) options.stop = sequences
  }

  const body: Record<string, unknown> = {
    model,
    messages: ollamaMessages,
    stream: true,
  }
  if (Object.keys(options).length > 0) body.options = options

  if (anthropicTools.length > 0) {
    body.tools = translateTools(anthropicTools)
    // Best-effort: Ollama's native API does not document tool_choice control,
    // so a forced tool pick may fall back to the model's own judgment rather
    // than being enforced. Sent anyway since an unrecognised field is ignored
    // rather than rejected (probe-verified against a live daemon), and 'auto'
    // is the daemon's only real behaviour regardless of what is sent.
    const tc = anthropicBody.tool_choice as { type?: string; name?: string } | undefined
    if (tc?.type === 'any') {
      body.tool_choice = 'required'
    } else if (tc?.type === 'tool' && tc.name) {
      body.tool_choice = { type: 'function', function: { name: tc.name } }
    }
  }

  return body
}

// ── Response translation: Ollama NDJSON → Anthropic SSE ──────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * Translates Ollama's native NDJSON chat stream to Anthropic SSE format.
 *
 * Ollama streams one complete JSON object per line (not Server-Sent-Events):
 *   {"message":{"role":"assistant","content":"hi"},"done":false}
 *   ...
 *   {"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop",
 *    "prompt_eval_count":...,"eval_count":...}
 *
 * Tool calls arrive whole in the final (`done:true`) line rather than as
 * incremental argument fragments — probe-verified against a live daemon — so,
 * unlike the Grok/DeepSeek adapters, there is no partial-JSON accumulation to
 * do: each tool_use block is emitted as a single input_json_delta.
 */
async function translateOllamaStreamToAnthropic(
  ollamaResponse: Response,
  model: string,
): Promise<Response> {
  const messageId = `msg_ollama_${Date.now()}`
  const encoder = new TextEncoder()

  const { readable, sink } = createBackpressuredSseStream('Ollama', () => pump())
  const safeEnqueue = sink.enqueue
  const waitForDrain = sink.waitForDrain

  async function pump(): Promise<void> {
    let contentBlockIndex = 0
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let textBlockOpen = false
    let thinkingBlockOpen = false
    let hadToolCalls = false
    let streamErrored = false
    let aborted = false
    let doneReasonValue: string | null = null
    let sawDone = false
    let sawAnyLine = false

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

    function emitToolCalls(toolCalls: OllamaToolCall[]): void {
      for (const tc of toolCalls) {
        const id = tc.id || `toolu_${messageId}_${contentBlockIndex}`
        safeEnqueue(encoder.encode(formatSSE('content_block_start', JSON.stringify({
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'tool_use', id, name: tc.function.name, input: {} },
        }))))
        safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.function.arguments ?? {}) },
        }))))
        safeEnqueue(encoder.encode(formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: contentBlockIndex,
        }))))
        contentBlockIndex++
      }
    }

    const reader = ollamaResponse.body?.getReader()
    if (!reader) {
      logError(new Error('Ollama: response body is null — no stream received'))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Ollama: response body is null — no stream received' },
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
        if (buffer.length > MAX_LINE_BYTES) {
          throw new Error(`Ollama NDJSON line exceeded ${MAX_LINE_BYTES} bytes`)
        }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          sawAnyLine = true

          let event: Record<string, unknown>
          try {
            event = JSON.parse(trimmed) as Record<string, unknown>
          } catch {
            logForDebugging(`Ollama NDJSON: malformed JSON line, skipped: ${trimmed.slice(0, 200)}`, { level: 'warn' })
            continue
          }

          // Ollama reports a mid-generation failure as a 200 stream whose final
          // line carries an `error` field instead of `done:true` — without this
          // it would fall through and look like a clean, empty completion.
          if (typeof event.error === 'string') {
            throw new Error(`Ollama stream error: ${event.error}`)
          }

          const message = event.message as {
            content?: string
            thinking?: string
            tool_calls?: OllamaToolCall[]
          } | undefined

          if (message?.thinking) {
            closeTextBlock()
            openThinkingBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: message.thinking },
            }))))
          }

          if (message?.content) {
            closeThinkingBlock()
            openTextBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: message.content },
            }))))
          }

          if (message?.tool_calls?.length) {
            closeThinkingBlock()
            closeTextBlock()
            emitToolCalls(message.tool_calls)
            hadToolCalls = true
          }

          if (event.done === true) {
            sawDone = true
            doneReasonValue = typeof event.done_reason === 'string' ? event.done_reason : null
            const promptEvalCount = typeof event.prompt_eval_count === 'number' ? event.prompt_eval_count : inputTokens
            const promptEvalCachedCount =
              typeof event.prompt_eval_cached_count === 'number' ? event.prompt_eval_cached_count : 0
            // Anthropic's usage shape keeps these additive — input_tokens is
            // the newly-evaluated portion, cache_read_input_tokens the reused
            // one — rather than Ollama's prompt_eval_count, which (like a raw
            // token count) already includes the cached prefix.
            cachedTokens = promptEvalCachedCount
            inputTokens = promptEvalCount - promptEvalCachedCount
            outputTokens = typeof event.eval_count === 'number' ? event.eval_count : outputTokens
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        aborted = true
        logForDebugging('Ollama stream: aborted', { level: 'debug' })
      } else {
        streamErrored = true
        logError(err)
        safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Ollama stream failed: ${err instanceof Error ? err.message : String(err)}` },
        }))))
      }
    } finally {
      reader.releaseLock()
      sink.setUpstreamReader(null)
    }

    if (aborted || streamErrored) {
      await sink.close()
      return
    }

    if (!sawAnyLine) {
      const detail = rawPreview ? `: ${rawPreview}` : ''
      logError(new Error(`Ollama: 200 response contained no stream lines${detail}`))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Ollama: 200 response contained no stream lines${detail}` },
      }))))
      await sink.close()
      return
    }

    // A stream that ends without a done:true line was cut off mid-generation —
    // same reasoning as the Grok/DeepSeek adapters' missing-finish_reason check.
    if (!sawDone) {
      const message = 'Ollama stream ended without done:true — the response was cut short'
      logError(new Error(message))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message },
      }))))
      await sink.close()
      return
    }

    if (doneReasonValue !== null && !MODELLED_DONE_REASONS.includes(doneReasonValue)) {
      const message = `Ollama stream stopped with unhandled done_reason '${doneReasonValue}'`
      logError(new Error(message))
      safeEnqueue(encoder.encode(formatSSE('error', JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message },
      }))))
      await sink.close()
      return
    }

    closeTextBlock()
    closeThinkingBlock()

    const stopReason = doneReasonValue === 'length' ? 'max_tokens' : hadToolCalls ? 'tool_use' : 'end_turn'

    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cachedTokens,
    }

    safeEnqueue(encoder.encode(formatSSE('message_delta', JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    }))))

    safeEnqueue(encoder.encode(formatSSE('message_stop', JSON.stringify({
      type: 'message_stop',
      usage,
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
 * Collapses the translated Anthropic SSE stream into a single Anthropic
 * Message response. Re-uses the streaming translation so both paths stay in
 * sync, the same way the Grok and DeepSeek adapters do.
 */
async function aggregateStreamToMessage(
  streamResponse: Response,
  model: string,
): Promise<Response> {
  const message: Record<string, unknown> = {
    id: `msg_ollama_${Date.now()}`,
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
    const message = 'Ollama: translated stream had no body to aggregate'
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
                block.input = json ? JSON.parse(json) : {}
              } catch (err) {
                logError(new Error(`Ollama: unparseable tool arguments for '${String(block.name ?? 'unknown')}': ${String(err)}`))
                blocks[index] = {
                  type: 'text',
                  text: `[Ollama returned an unparseable argument list for tool '${String(block.name ?? 'unknown')}'; the call was not made.]`,
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
          case 'error': {
            const err = data.error as { message?: string } | undefined
            streamError = err?.message ?? 'Ollama stream failed'
            break
          }
          case 'ping':
            break
          default:
            logForDebugging(
              `Ollama: unhandled Anthropic SSE event '${eventName}' while aggregating a non-streaming response`,
              { level: 'warn' },
            )
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (streamError) {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamError } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

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
    default: return 'api_error'
  }
}

function describeOllamaError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null
    return typeof parsed?.error === 'string' ? parsed.error : body.trim().slice(0, 300)
  } catch {
    return body.trim().slice(0, 300) || 'no response body'
  }
}

// ── Main fetch interceptor ────────────────────────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes them
 * to a local Ollama daemon's native `/api/chat` endpoint.
 *
 * @param baseUrl - The stored account's own daemon address (never the
 *   OLLAMA_BASE_URL default — a self-hosted account's address would otherwise
 *   be silently ignored)
 * @param authToken - Sent as `Authorization: Bearer`; ignored by a local
 *   daemon, required by Ollama Cloud
 * @param inner - The fetch to send the translated request with, and to pass
 *   untranslated requests through to — mirrors createGrokFetch/createDeepSeekFetch
 * @returns A fetch suitable for the Anthropic SDK's `fetch` option
 */
export function createOllamaFetch(
  baseUrl: string,
  authToken: string,
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

    // The model field already carries the real Ollama tag — ownedModel in
    // config/providers/ollama.ts makes the stored account's model string
    // authoritative, so unlike Grok/DeepSeek there is no Claude-family mapping
    // to do here.
    const model = (anthropicBody.model as string | undefined) ?? ''
    const ollamaBody = translateToOllamaBody(anthropicBody, model)

    logForDebugging(`OLLAMA_DEBUG_REQUEST ${JSON.stringify(ollamaBody)}`, { level: 'warn' })

    const ollamaResponse = await inner(`${baseUrl}${OLLAMA_CHAT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(ollamaBody),
      ...(init?.signal && { signal: init.signal }),
      ...getProxyFetchOptions({ forAnthropicAPI: false }),
    })

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text()
      const errorBody = {
        type: 'error',
        error: {
          type: anthropicErrorType(ollamaResponse.status),
          message: `Ollama API error (${ollamaResponse.status}): ${describeOllamaError(errorText)}`,
        },
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      for (const name of ['retry-after-ms', 'retry-after']) {
        const value = ollamaResponse.headers.get(name)
        if (value) headers[name] = value
      }
      return new Response(JSON.stringify(errorBody), {
        status: ollamaResponse.status,
        headers,
      })
    }

    const anthropicStream = await translateOllamaStreamToAnthropic(ollamaResponse, model)
    return anthropicBody.stream === true
      ? anthropicStream
      : aggregateStreamToMessage(anthropicStream, model)
  }
}
