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
  /**
   * Whether this provider can serve the given model ID *now*.
   *
   * Answers a question about the present, not about ownership: callers use it
   * to decide whether a `/model` choice, `ANTHROPIC_MODEL` or a stored
   * per-account model is still usable, and to size the context window. Claiming
   * an ID the endpoint would 404 therefore does real harm — model.ts's
   * resolution path would adopt it instead of healing to {@link defaultModel}.
   * IDs the API no longer serves belong in {@link wasRetiredModel}.
   */
  acceptsModel: (model: string) => boolean
  /**
   * Whether this provider *used to* serve the given model ID and no longer does.
   *
   * Ownership without servability. It exists for attribution: deciding which
   * account produced an assistant message in the transcript, so that thinking
   * blocks carrying another account's credential-bound signature are dropped
   * before they are replayed. Read in two places, both in that service of that
   * one question — `isRetiredModelOfActiveProvider` (utils/model/model.ts) for
   * "is this the active account's own retired model", and
   * `isModelOwnedByACatalog` (./index.ts) for "does it belong to some catalog
   * at all", which is how a provider with no catalog of its own recognises a
   * foreign ID.
   *
   * Both are needed. Miss the first and a session on the very provider that
   * retired the ID reads its own thinking as foreign; miss the second and an
   * Anthropic session reads a retired ID as unowned, hence its own.
   *
   * Kept out of {@link getProviderModelCatalogForModel} so a retired ID neither
   * becomes selectable nor inherits {@link contextWindow} — `moonshot-v1-8k`
   * names a window nothing here can honour. That is why the ownership question
   * needs its own lookup rather than reusing that one.
   *
   * Omit it when a provider's retired IDs are still served as aliases: those
   * are servable, so they belong in {@link acceptsModel} (see deepseek.ts).
   */
  wasRetiredModel?: (model: string) => boolean
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
