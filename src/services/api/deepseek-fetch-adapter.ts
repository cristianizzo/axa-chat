/**
 * DeepSeek Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to DeepSeek's
 * OpenAI-compatible Chat Completions API, translating between Anthropic Messages
 * API format and OpenAI Chat Completions format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → system role message
 * - Tool definitions (Anthropic input_schema → OpenAI function parameters)
 * - Tool use (tool_use → function call, tool_result → tool role message)
 * - Streaming events translation (OpenAI SSE → Anthropic SSE)
 * - DeepSeek R1 reasoning_content → thinking content blocks
 *
 * Endpoint: https://api.deepseek.com/v1/chat/completions
 */

import { DEEPSEEK_BASE_URL, DEEPSEEK_MAX_OUTPUT_TOKENS, DEEPSEEK_MESSAGES_PATH, DEFAULT_DEEPSEEK_MODEL } from '../../config/deepseek.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

// 1 MiB per SSE line — a legitimate response never approaches this
const MAX_SSE_LINE_BYTES = 1_048_576

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
  content: string | null
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
        // thinking/redacted_thinking blocks are skipped — DeepSeek handles its own reasoning
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
      const textParts: string[] = []
      const toolResults: OpenAIMessage[] = []

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
        } else {
          textParts.push(`[Unsupported ${block.type} attachment omitted from this request.]`)
        }
      }

      // Tool results first (they logically precede the next user message)
      result.push(...toolResults)

      if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('') })
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
    // Clamp to DeepSeek's hard cap to prevent immediate 400s when the SDK
    // sends the Claude default (32k–64k), which exceeds DeepSeek's 8k limit.
    body.max_tokens = Math.min(anthropicBody.max_tokens, DEEPSEEK_MAX_OUTPUT_TOKENS.upperLimit)
  }

  if (typeof anthropicBody.temperature === 'number') {
    body.temperature = anthropicBody.temperature
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
 * Maps an Anthropic model name to the appropriate DeepSeek model.
 * Claude Opus/Sonnet → deepseek-reasoner (R1), Claude Haiku → deepseek-chat (V3).
 * Any already-valid DeepSeek model ID passes through untouched.
 */
function resolveModel(claudeModel: string | undefined): string {
  if (!claudeModel) return DEFAULT_DEEPSEEK_MODEL

  const lower = claudeModel.toLowerCase()

  // Already a DeepSeek model — pass through
  if (lower.startsWith('deepseek-')) return claudeModel

  // Map Claude families to DeepSeek equivalents
  if (lower.includes('opus')) return 'deepseek-reasoner'
  if (lower.includes('sonnet')) return 'deepseek-reasoner'
  if (lower.includes('haiku')) return 'deepseek-chat'

  logForDebugging(`DeepSeek resolveModel: unrecognised model '${claudeModel}', falling back to '${DEFAULT_DEEPSEEK_MODEL}'`, { level: 'warn' })
  return DEFAULT_DEEPSEEK_MODEL
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
 * DeepSeek R1 adds:
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
  const messageId = `msg_deepseek_${Date.now()}`
  const encoder = new TextEncoder()

  const pendingBuffer: Uint8Array[] = []
  let bufferHead = 0
  let streamController: ReadableStreamDefaultController | null = null
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let finished = false
  let notifyDrained: (() => void) | null = null
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
      return new Promise<void>(resolve => {
        notifyProduced = resolve
      })
    },
    async cancel(reason) {
      finished = true
      releaseWaiters()
      try {
        await upstreamReader?.cancel(reason)
      } catch (err) {
        logForDebugging(`DeepSeek stream cancel error: ${String(err)}`, { level: 'debug' })
      }
    },
  })

  async function pump(): Promise<void> {
    let contentBlockIndex = 0
    let inputTokens = 0
    let outputTokens = 0
    let textBlockOpen = false
    let thinkingBlockOpen = false
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let toolBlocksFlushed = false
    let hadToolCalls = false
    let streamErrored = false
    let finishReasonReceived = false
    let lengthTruncated = false

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
      if (toolBlocksFlushed || toolCalls.size === 0) return
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
      toolBlocksFlushed = true
    }


    const reader = openAIResponse.body?.getReader()
    if (!reader) {
      closeTextBlock()
      await finishStream({ inputTokens, outputTokens, hadToolCalls, errored: true, lengthTruncated: false })
      return
    }
    upstreamReader = reader

    try {
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        await waitForDrain()
        if (finished) break

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > MAX_SSE_LINE_BYTES) {
          throw new Error(`DeepSeek SSE frame exceeded ${MAX_SSE_LINE_BYTES} bytes`)
        }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const dataStr = trimmed.slice(6)
          if (dataStr === '[DONE]') continue

          let event: Record<string, unknown>
          try {
            event = JSON.parse(dataStr) as Record<string, unknown>
          } catch {
            logForDebugging(`DeepSeek SSE: malformed JSON (${dataStr.length} chars)`, { level: 'warn' })
            continue
          }

          // Usage information (may appear in the final chunk)
          const usage = event.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
          if (usage) {
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
              finishReasonReceived = true
              if (choice.finish_reason === 'tool_calls') hadToolCalls = true
              if (choice.finish_reason === 'length') lengthTruncated = true
            }
            continue
          }

          // ── Reasoning content (DeepSeek R1) ──────────────────────────────
          if (delta.reasoning_content) {
            closeTextBlock()
            flushToolBlocks()
            openThinkingBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }))))
            outputTokens++
          }

          // ── Text content ──────────────────────────────────────────────────
          if (delta.content) {
            closeThinkingBlock()
            flushToolBlocks()
            openTextBlock()
            safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }))))
            outputTokens++
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
                    id: tc.id ?? `toolu_${Date.now()}`,
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
                } else {
                  logForDebugging(
                    `DeepSeek SSE: argument delta for unknown tool index ${tcIndex}`,
                    { level: 'warn' },
                  )
                }
              }
            }

            if (choice.finish_reason === 'tool_calls') {
              finishReasonReceived = true
              hadToolCalls = true
            }
          }

          // Track finish_reason even when it arrives alongside a delta (e.g. finish_reason:'stop')
          if (choice.finish_reason && !finishReasonReceived) {
            finishReasonReceived = true
            if (choice.finish_reason === 'length') lengthTruncated = true
          }
        }
      }
    } catch (err) {
      streamErrored = true
      logError(err)
      const userMsg = '\n\n[The connection to DeepSeek was interrupted. Please try again.]'
      if (!textBlockOpen) {
        closeThinkingBlock()
        flushToolBlocks()
        openTextBlock()
      }
      safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: userMsg },
      }))))
    } finally {
      reader.releaseLock()
      upstreamReader = null
    }

    // If the stream ended without a finish_reason (truncated connection), warn the user
    if (!streamErrored && !finishReasonReceived && contentBlockIndex > 0) {
      logForDebugging('DeepSeek SSE: stream ended without finish_reason — response may be incomplete', { level: 'warn' })
      if (!textBlockOpen) {
        closeThinkingBlock()
        flushToolBlocks()
        openTextBlock()
      }
      safeEnqueue(encoder.encode(formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: '\n\n[Warning: DeepSeek response was cut short — the answer may be incomplete.]' },
      }))))
    }

    // Close any open blocks
    closeTextBlock()
    closeThinkingBlock()
    flushToolBlocks()

    await finishStream({ inputTokens, outputTokens, hadToolCalls, errored: streamErrored, lengthTruncated })
  }

  async function finishStream(opts: {
    inputTokens: number
    outputTokens: number
    hadToolCalls: boolean
    errored: boolean
    lengthTruncated: boolean
  }): Promise<void> {
    const stopReason = opts.lengthTruncated
      ? 'max_tokens'
      : opts.hadToolCalls && !opts.errored
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

    await waitForDrain()
    if (finished) return
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
    id: `msg_deepseek_${Date.now()}`,
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

  const reader = streamResponse.body?.getReader()
  if (!reader) return new Response(JSON.stringify(message), { status: 200, headers: { 'Content-Type': 'application/json' } })

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
                logError(new Error(`DeepSeek: unparseable tool arguments for '${String(block.name ?? 'unknown')}': ${String(err)}`))
                blocks[index] = {
                  type: 'text',
                  text: `[DeepSeek returned an unparseable argument list for tool '${String(block.name ?? 'unknown')}'; the call was not made.]`,
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
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  message.content = blocks.filter(Boolean)
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Token count estimation ────────────────────────────────────────────────────

/**
 * DeepSeek has no token-counting endpoint. Estimate from the serialised prompt
 * so the SDK's compaction logic stays functional.
 */
async function estimateTokenCountResponse(
  anthropicBody: Record<string, unknown>,
): Promise<Response> {
  const { roughTokenCountEstimation } = await import('../tokenEstimation.js')
  const countable = JSON.stringify(
    [anthropicBody.system ?? '', anthropicBody.messages ?? [], anthropicBody.tools ?? []],
    function (this: unknown, key, value) {
      const parent = this as { type?: unknown } | undefined
      if (key === 'data' && parent?.type === 'base64') return undefined
      return value
    },
  )
  return new Response(JSON.stringify({ input_tokens: roughTokenCountEstimation(countable) }), {
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

function describeDeepSeekError(body: string): string {
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
 * to DeepSeek's OpenAI-compatible Chat Completions API.
 *
 * @param apiKey - The DeepSeek API key for Bearer authentication
 * @param inner - The fetch to send the translated request with, and to pass
 *   untranslated requests through to. Taking it as an argument is what lets the
 *   caller wrap DeepSeek traffic the same way it wraps every other provider's:
 *   the concurrency limiter and the request logging live in that fetch. Proxy
 *   options do not — the outbound call below sets its own.
 * @returns A fetch suitable for the Anthropic SDK's `fetch` option
 */
export function createDeepSeekFetch(
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

    const deepSeekResponse = await inner(`${DEEPSEEK_BASE_URL}${DEEPSEEK_MESSAGES_PATH}`, {
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

    if (!deepSeekResponse.ok) {
      const errorText = await deepSeekResponse.text()
      const errorBody = {
        type: 'error',
        error: {
          type: anthropicErrorType(deepSeekResponse.status),
          message: `DeepSeek API error (${deepSeekResponse.status}): ${describeDeepSeekError(errorText)}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: deepSeekResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const anthropicStream = await translateOpenAIStreamToAnthropic(deepSeekResponse, model)
    return anthropicBody.stream === true
      ? anthropicStream
      : aggregateStreamToMessage(anthropicStream, model)
  }
}
