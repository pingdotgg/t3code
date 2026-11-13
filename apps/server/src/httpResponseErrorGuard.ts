// These guards run on the raw Node HTTP server before Effect handles requests.
// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import { DATABASE_MIGRATION_STATUS_HEADER } from "@t3tools/shared/databaseMigrationLog";

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

// cloudflared and Tailscale serve keep an idle connection to this server for 90
// seconds. Node's 5 second default closes it first, so they can send a request
// into a closed connection, and a slow client reconnects in the middle of a connect.
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 95_000;

/** Install before `rejectRequestsUntilServing`, whose handoff starts at the next request listener. */
export function keepIdleConnections<T extends NodeHttp.Server>(server: T): T {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  // `close` drops only the connections idle at that moment. One that finishes
  // its responses later would hold shutdown for the whole keep-alive time.
  // `closeIdleConnections` cannot do this: it destroys a socket whose next
  // pipelined response is ended but still has output to send.
  const responsesInFlight = new WeakMap<object, number>();
  server.on("request", (request, response) => {
    const socket = request.socket;
    responsesInFlight.set(socket, (responsesInFlight.get(socket) ?? 0) + 1);
    response.once("close", () => {
      const left = (responsesInFlight.get(socket) ?? 1) - 1;
      responsesInFlight.set(socket, left);
      // Pipelined requests share the socket, so the last response ends it.
      if (left === 0 && !server.listening) socket.end();
    });
  });
  return server;
}

/**
 * NodeHttpServer listens before serve() attaches its handlers, so requests in
 * between would hang. Install this after the write-error guards so only the
 * serving handlers trigger the handoff.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(
  server: T,
  readMigrationProgress: () => string | undefined = () => undefined,
): T {
  const rejection = () => {
    const progress = readMigrationProgress();
    if (progress === undefined) return { headers: {}, body: "" };
    return {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        [DATABASE_MIGRATION_STATUS_HEADER]: progress,
      },
      body: `Upgrading database, ${progress}`,
    };
  };
  const rejectRequest = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const { headers, body } = rejection();
    response.writeHead(503, { ...headers, "retry-after": "1", connection: "close" }).end(body);
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    const { headers, body } = rejection();
    const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n${headerLines.join("")}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, making the handoff synchronous.
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
