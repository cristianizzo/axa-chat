/**
 * SDK Control Types - the control protocol's TypeScript surface.
 *
 * Every type here is inferred from the Zod schema that already defines it, so
 * the schema stays the single source of truth and the two cannot drift. To
 * change a type, change the schema in `controlSchemas.ts` (or `coreSchemas.ts`)
 * and the type follows.
 *
 * The schemas are wrapped in `lazySchema`, which defers construction to first
 * access and therefore types as `() => Schema` rather than `Schema`. Inference
 * must go through the call: `z.infer<ReturnType<typeof FooSchema>>`.
 *
 * Keep the `ReturnType`. A bare `z.infer<typeof FooSchema>` compiles without
 * error and resolves to `unknown`, which then accepts anything at every use
 * site — so the mistake costs all type safety here and reports nothing.
 *
 * Note: `coreTypes.generated.ts` also declares an `SDKPartialAssistantMessage`,
 * with `type: 'assistant_partial'`. That declaration is stale — the schema and
 * every live producer use `'stream_event'` — and this file follows the schema.
 */

import type { z } from 'zod/v4'
import type {
  SDKControlCancelRequestSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestInnerSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'
import type { SDKPartialAssistantMessageSchema } from './coreSchemas.js'

// ============================================================================
// Stream envelopes
// ============================================================================

/** Anything the CLI may write to stdout. */
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>

/** Anything the CLI may read from stdin. */
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>

// ============================================================================
// Control protocol envelopes
// ============================================================================

/** A control request together with its envelope (`type`, `request_id`). */
export type SDKControlRequest = z.infer<ReturnType<typeof SDKControlRequestSchema>>

/** The payload of a control request, without the envelope. */
export type SDKControlRequestInner = z.infer<
  ReturnType<typeof SDKControlRequestInnerSchema>
>

/** A control response together with its envelope. */
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>

// ============================================================================
// Individual control requests
// ============================================================================

export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>

export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>

export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>

// ============================================================================
// Individual control responses
// ============================================================================

export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>

export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>

export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>

// ============================================================================
// Streaming assistant output
// ============================================================================

/** A partial assistant message; `type` is `'stream_event'`. */
export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>
