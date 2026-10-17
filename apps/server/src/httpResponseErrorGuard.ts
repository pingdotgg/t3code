// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * An "error" event without a listener escalates into an uncaught exception and
 * terminates the whole server process, taking every other client and all
 * in-flight provider work with it.
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
