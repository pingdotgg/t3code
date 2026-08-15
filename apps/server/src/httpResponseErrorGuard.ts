// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * Node surfaces late socket write failures (EPIPE, ECONNRESET,
 * ERR_STREAM_DESTROYED) as "error" events. An "error" event without a
 * listener escalates into an uncaught exception and terminates the whole
 * server process, taking every other client and all in-flight provider
 * work with it.
 *
 * Two emitters need coverage:
 *
 * - Upgrade sockets. Once a connection upgrades (the websocket RPC path,
 *   including its auth rejection responses), Node's http server detaches
 *   its own socket error handling, so the raw socket has no listener at
 *   all until the websocket server adopts it.
 * - Server responses. Response streams have no default error listener
 *   either.
 *
 * A disconnected client only affects its own request: the request fiber is
 * already interrupted through the response "close" event, so the write
 * failure needs no handling beyond being observed.
 */
export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}
