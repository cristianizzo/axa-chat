/**
 * The model-facing half of a {@link ProviderDescriptor}, for providers whose
 * complete catalog is known locally.
 *
 * Split into its own file only to keep the descriptor type readable; it is one
 * field on it, not a second registry. It used to be one — `providerModels.ts`
 * kept a `Partial<Record<AuthProviderId, …>>` alongside `authProviders.ts`'s
 * account list, and the two could disagree about which providers existed.
 */

export type ProviderModelOption = {
  id: string
  label: string
  description: string
}

export type ProviderModelCatalog = {
  models: readonly ProviderModelOption[]
  defaultModel: string
  contextWindow: number
  maxOutputTokens: { default: number; upperLimit: number }
  acceptsModel: (model: string) => boolean
  /**
   * What this provider serves in place of Haiku for background work — session
   * titles, away summaries, WebFetch extraction, token estimation.
   *
   * Without it those callers ask for a `claude-*` ID against an endpoint that
   * has never heard of one. Providers with a translating fetch adapter could
   * paper over that on the way out; a provider speaking Anthropic natively has
   * nowhere to do so, which is why the mapping belongs here instead.
   */
  smallFastModel: string
  /**
   * Whether the endpoint accepts `tool_reference` blocks.
   *
   * The existing gate in toolSearch.ts only recognises an Anthropic-shaped
   * proxy sitting behind `firstParty`, so a provider with its own APIProvider
   * ID falls straight through it and is assumed capable.
   */
  supportsToolSearch: boolean
  /**
   * How many requests this endpoint will process at once, if it is few enough
   * to matter. Omitted means "enough that the CLI need not think about it".
   *
   * The CLI fans out up to ten concurrent tool calls, which is fine against a
   * backend sized for it and useless against one that answers a single request
   * at a time — the other nine come back as rate-limit errors. Providers that
   * publish a small concurrency allowance state it here and
   * `limitRequestConcurrency` spaces the requests out instead.
   */
  maxConcurrentRequests?: number
}
