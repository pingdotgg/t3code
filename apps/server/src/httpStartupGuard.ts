// Hooks the raw Node http.Server before Effect attaches its handlers.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

const STARTUP_RETRY_AFTER_SECONDS = "1";

/**
 * `NodeHttpServer.make` calls `listen()` while the HTTP server layer is
 * built, but the request and upgrade handlers only attach later in `serve()`,
 * after the rest of the startup graph (SQLite, providers, routes). Node emits
 * `request` with no app listener in that window and never replays it, so a
 * client that connects early hangs until it gives up.
 *
 * Answer 503 + Retry-After until the real handlers register, then step aside.
 * `newListener` fires synchronously before each handler is added, so nothing
 * slips through between the two.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  const rejectRequest = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    response
      .writeHead(503, {
        "retry-after": STARTUP_RETRY_AFTER_SECONDS,
        "content-type": "text/plain",
        connection: "close",
      })
      .end("T3 Code server is starting.");
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${STARTUP_RETRY_AFTER_SECONDS}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  server.on("newListener", function onNewListener(event) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
