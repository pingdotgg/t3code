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

/**
 * `NodeHttpServer` listens while its layer builds but attaches its request
 * and upgrade handlers only when `HttpRouter.serve` runs, after the whole
 * runtime graph: about a second at startup. Node accepts connections in that
 * window, and with no handler they were never answered, so a client that
 * reconnected into it waited out its socket timeout. Park those requests and
 * hand them to the first real handler, which answers them like any request
 * that arrived a moment later.
 */
export function holdRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  for (const event of ["request", "upgrade"] as const) {
    const parked: Array<ReadonlyArray<unknown>> = [];
    const park = (...args: ReadonlyArray<unknown>) => {
      parked.push(args);
    };
    const onNewListener = (name: string | symbol) => {
      if (name !== event) return;
      server.off("newListener", onNewListener);
      server.off(event, park);
      // "newListener" fires before the listener is added. A microtask runs
      // once it is, and before any later connection's I/O callback, so parked
      // requests still reach the handler in arrival order.
      queueMicrotask(() => {
        for (const args of parked.splice(0)) server.emit(event, ...args);
      });
    };
    server.on(event, park);
    server.on("newListener", onNewListener);
  }
  return server;
}
