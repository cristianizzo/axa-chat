/**
 * SDK core types, derived from the Zod schemas in `coreSchemas.ts`.
 *
 * `coreSchemas.ts` is the single source of truth. Every type below is a
 * `z.infer` over the corresponding schema, so a schema edit propagates here
 * automatically and the two can never drift.
 *
 * Note the `ReturnType<...>` in every alias: the schemas are wrapped in
 * `lazySchema()`, so `typeof FooSchema` is `() => ZodType`, not the schema.
 * A bare `z.infer<typeof FooSchema>` silently resolves to `unknown` and
 * destroys type safety at every use site — always go through `ReturnType`.
 */

import type { z } from 'zod/v4'
import type {
  AsyncHookJSONOutputSchema,
  ExitReasonSchema,
  HookEventSchema,
  HookInputSchema,
  HookJSONOutputSchema,
  ModelUsageSchema,
  PermissionModeSchema,
  PermissionResultSchema,
  SDKAssistantMessageErrorSchema,
  SDKAssistantMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKMessageSchema,
  SDKPartialAssistantMessageSchema,
  SDKPermissionDenialSchema,
  SDKRateLimitInfoSchema,
  SDKResultMessageSchema,
  SDKSessionInfoSchema,
  SDKStatusMessageSchema,
  SDKStatusSchema,
  SDKSystemMessageSchema,
  SDKToolProgressMessageSchema,
  SDKUserMessageReplaySchema,
  SDKUserMessageSchema,
  SyncHookJSONOutputSchema,
} from './coreSchemas.js'

// ============================================================================
// Enums
// ============================================================================

export type PermissionMode = z.infer<ReturnType<typeof PermissionModeSchema>>

export type ExitReason = z.infer<ReturnType<typeof ExitReasonSchema>>

export type HookEvent = z.infer<ReturnType<typeof HookEventSchema>>

// ============================================================================
// Usage & status
// ============================================================================

export type ModelUsage = z.infer<ReturnType<typeof ModelUsageSchema>>

export type SDKStatus = z.infer<ReturnType<typeof SDKStatusSchema>>

export type SDKRateLimitInfo = z.infer<ReturnType<typeof SDKRateLimitInfoSchema>>

// ============================================================================
// SDK messages
// ============================================================================

export type SDKAssistantMessage = z.infer<
  ReturnType<typeof SDKAssistantMessageSchema>
>

/**
 * The *reason* an assistant turn failed, carried on `SDKAssistantMessage.error`
 * and returned by `categorizeRetryableAPIError`. It is an enum of error codes,
 * not a message envelope.
 */
export type SDKAssistantMessageError = z.infer<
  ReturnType<typeof SDKAssistantMessageErrorSchema>
>

/** Streaming partial assistant output. Its `type` is `'stream_event'`. */
export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>

export type SDKResultMessage = z.infer<ReturnType<typeof SDKResultMessageSchema>>

export type SDKStatusMessage = z.infer<ReturnType<typeof SDKStatusMessageSchema>>

export type SDKSystemMessage = z.infer<ReturnType<typeof SDKSystemMessageSchema>>

export type SDKCompactBoundaryMessage = z.infer<
  ReturnType<typeof SDKCompactBoundaryMessageSchema>
>

export type SDKToolProgressMessage = z.infer<
  ReturnType<typeof SDKToolProgressMessageSchema>
>

/**
 * A record of a tool call that was denied. Accumulated by QueryEngine and
 * reported on the result message's `permission_denials`; it is not itself a
 * message in the `SDKMessage` stream.
 */
export type SDKPermissionDenial = z.infer<
  ReturnType<typeof SDKPermissionDenialSchema>
>

export type SDKUserMessage = z.infer<ReturnType<typeof SDKUserMessageSchema>>

export type SDKUserMessageReplay = z.infer<
  ReturnType<typeof SDKUserMessageReplaySchema>
>

export type SDKMessage = z.infer<ReturnType<typeof SDKMessageSchema>>

// ============================================================================
// Sessions, permissions & hooks
// ============================================================================

export type SDKSessionInfo = z.infer<ReturnType<typeof SDKSessionInfoSchema>>

export type PermissionResult = z.infer<ReturnType<typeof PermissionResultSchema>>

export type HookInput = z.infer<ReturnType<typeof HookInputSchema>>

export type SyncHookJSONOutput = z.infer<
  ReturnType<typeof SyncHookJSONOutputSchema>
>

export type AsyncHookJSONOutput = z.infer<
  ReturnType<typeof AsyncHookJSONOutputSchema>
>

export type HookJSONOutput = z.infer<ReturnType<typeof HookJSONOutputSchema>>
