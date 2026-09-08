export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  /**
   * Set from a `signature_delta` while streaming — see the `signature_delta`
   * case in `services/api/claude.ts`, which assigns it whenever the open block
   * is a `connector_text`. Optional because it only exists once that delta has
   * arrived; a block is a valid `ConnectorTextBlock` before then, which is why
   * `isConnectorTextBlock` does not check for it.
   */
  signature?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'connector_text' in value &&
    (value as { type?: unknown }).type === 'connector_text' &&
    typeof (value as { connector_text?: unknown }).connector_text === 'string'
  )
}
