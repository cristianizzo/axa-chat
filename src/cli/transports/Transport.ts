import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'

/**
 * The read/write channel between this CLI process and a remote session.
 *
 * `getTransportForUrl()` in transportUtils.ts selects one of three
 * implementations at construction time and returns it as a `Transport`, so
 * this type is the entire surface a caller holding the factory's result can
 * rely on:
 *
 * - SSETransport      — SSE reads + HTTP POST writes (CCR v2)
 * - HybridTransport   — WS reads + HTTP POST writes (Session-Ingress)
 * - WebSocketTransport — WS reads + WS writes (default)
 *
 * HybridTransport satisfies this by extending WebSocketTransport rather than
 * declaring `implements` itself.
 *
 * The members below are exactly those that all three provide. Capabilities
 * held by only some implementations are deliberately NOT declared here, even
 * as optionals — widening this type would let a caller reach for a method the
 * factory might not have handed it:
 *
 * - `getLastSequenceNum()` / `setOnEvent()` — SSETransport only.
 * - `setOnConnect()` / `getStateLabel()`    — WebSocketTransport (and so
 *   HybridTransport) only.
 * - `writeBatch()` / `flush()` / `droppedBatchCount` — HybridTransport only.
 *
 * Callers needing a superset take it through a narrower type: remoteIO.ts
 * asserts `instanceof SSETransport` before constructing CCRClient, and
 * src/bridge/replBridge.ts uses ReplBridgeTransport
 * (src/bridge/replBridgeTransport.ts) — note that is a top-level `src/bridge/`,
 * not a subdirectory of this one — whose adapters fill each gap explicitly:
 * the v1 adapter returns 0 from `getLastSequenceNum()`, and the v2 adapter
 * synthesises `getStateLabel()` and `setOnConnect()`, neither of which
 * SSETransport has.
 *
 * Three unrelated things share the name `Transport`, so grepping for it — or
 * for `implements Transport`, which matches 6 classes in src/ of which only 2
 * are this contract — will not partition them:
 *
 * - the MCP SDK's `Transport` interface, imported from
 *   `@modelcontextprotocol/sdk/shared/transport.js`. This is the one the other
 *   four `implements Transport` clauses in src/ satisfy (services/mcp/
 *   InProcessTransport.ts, SdkControlTransport.ts twice, and
 *   utils/mcpWebSocketTransport.ts).
 * - the Zod-derived MCP server *config* type in services/mcp/types.ts, which
 *   is a settings shape rather than a channel.
 * - separately, the `WebSocketTransport` *class* in utils/mcpWebSocketTransport.ts
 *   collides with the one in this directory; it implements the SDK interface
 *   above, not this one.
 */
export interface Transport {
  /**
   * Open the channel. Resolves once the connect attempt has been made, not
   * once the peer is confirmed — poll isConnectedStatus() for that.
   * Implementations reconnect internally, so this is called once per
   * transport instance.
   */
  connect(): Promise<void>

  /** Send one message. */
  write(message: StdoutMessage): Promise<void>

  /** Close the channel and cancel any pending reconnect. Idempotent. */
  close(): void

  isConnectedStatus(): boolean

  isClosedStatus(): boolean

  /** Register the handler for inbound data. Replaces any previous handler. */
  setOnData(callback: (data: string) => void): void

  /**
   * Register the close handler. Replaces any previous handler. `closeCode` is
   * the WebSocket close code where one exists, and is absent otherwise.
   */
  setOnClose(callback: (closeCode?: number) => void): void
}
