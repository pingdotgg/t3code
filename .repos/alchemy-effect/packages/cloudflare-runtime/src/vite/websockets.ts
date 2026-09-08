import * as NodeHttp from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type * as vite from "vite";
import { resolveForwardedHost } from "./forwarded-host.ts";

/**
 * Handles 'upgrade' requests on the Vite HTTP server and forwards the
 * WebSocket handshake to the local workerd address as a raw HTTP upgrade.
 *
 * Returns a cleanup function that removes the listener (used on server restart).
 */
export function handleWebSocket(
  httpServer: vite.HttpServer,
  address: string | URL,
): () => void {
  const upstreamBase = typeof address === "string" ? new URL(address) : address;

  // Sockets hijacked by an `upgrade` are not reaped by `server.closeAllConnections()`,
  // yet `server.close()` still waits on them — so a lingering proxied WebSocket blocks
  // the HTTP server from closing on restart. Track live sockets and destroy them in the
  // cleanup function to close deterministically.
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    // Unhandled socket errors crash Node.
    socket.on("error", () => socket.destroy());

    // The URL — and thus the Sandbox-origin check below — is built from the
    // resolved (forwarded) host, not the raw `Host` header. This diverges from
    // upstream, which keys the origin off `Host`; here it's intentional so a
    // tunnel-fronted Sandbox preview still matches. Direct Sandbox hits carry no
    // `X-Forwarded-Host`, so they fall back to `Host` and behave identically.
    const rawHost = resolveForwardedHost(request.headers, "localhost");
    const base = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
    const url = new URL(request.url ?? "/", base);

    const isViteRequest =
      request.headers["sec-websocket-protocol"]?.startsWith("vite") ?? false;
    const isSandboxRequest = hasSandboxOrigin(url.origin);

    // Vite handles its own HMR upgrades; forward Sandbox preview URLs anyway.
    if (isViteRequest && !isSandboxRequest) {
      return;
    }

    const target = new URL(url.pathname + url.search, upstreamBase);
    const upstream = NodeHttp.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: request.method,
      // Forward the client-facing host so the worker sees the URL the client
      // requested rather than the local workerd address.
      headers: { ...request.headers, host: url.host },
    });

    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
    };

    upstream.on("error", cleanup);
    socket.on("close", () => upstream.destroy());

    upstream.on("response", (response) => {
      // Worker did not accept the upgrade.
      if (!socket.destroyed) {
        socket.destroy();
      }
      response.resume();
    });

    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => upstreamSocket.destroy());

      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }

      track(socket);
      track(upstreamSocket);

      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${
        upstreamRes.statusMessage ?? "Switching Protocols"
      }`;
      const headerLines: Array<string> = [statusLine];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        headerLines.push(
          `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`,
        );
      }
      socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);

      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }

      socket.pipe(upstreamSocket).pipe(socket);
    });

    // WebSocket upgrade requests carry no body, and any early client bytes are
    // forwarded above via `upstreamSocket.write(head)`. Ending the request
    // directly flushes the upstream handshake deterministically, rather than
    // relying on the incoming `request` stream to emit `end` (which can be
    // delayed by TCP timing) and avoids a second consumer of the client socket.
    upstream.end();
  };

  httpServer.on("upgrade", onUpgrade);
  return () => {
    httpServer.off("upgrade", onUpgrade);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
}

/**
 * Matches the origin of a Sandbox SDK preview URL.
 * See: https://developers.cloudflare.com/sandbox/concepts/preview-urls/
 *
 * Pattern: https?://<port(4+ digits)>-<id(no dots)>-<token>.localhost
 *
 * IMPORTANT: The token segment is [a-z0-9_]+ (no hyphens) to prevent ReDoS — two adjacent
 * [^.]+ groups separated by - cause quadratic backtracking on hyphen-heavy input. Tokens
 * are documented as letters/digits/underscores only.
 */
const SANDBOX_ORIGIN_REGEXP =
  /^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
  return SANDBOX_ORIGIN_REGEXP.test(origin);
}
