import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import { connectDockerSocket } from "./connect-docker-socket.ts";

/** Give up on a client that sends more header bytes than this. */
const MAX_HEADER_BYTES = 64 * 1024;

const isTcpUpgrade = (headers: string) => /^upgrade:\s*tcp\s*$/im.test(headers);

/**
 * A raw TCP front for the Docker HTTP proxy.
 *
 * workerd talks to Docker through our HTTP proxy, which rewrites some
 * requests. `docker exec` is different: Docker answers it with `101 UPGRADED`
 * and then streams raw, multiplexed stdin/stdout/stderr bytes over the same
 * socket. Bun 1.3 cannot hand an upgraded HTTP socket to userland, so those
 * requests must never reach the HTTP server.
 *
 * This router reads each connection's request headers, then pipes the whole
 * connection either straight to the Docker socket (`Upgrade: tcp`) or to the
 * HTTP proxy (everything else). Its scope destroys all sockets on shutdown.
 *
 * Bun 1.3.x only (repo pins 1.3.13): the `node:http` `upgrade` event fires but
 * writes to its socket never reach the client. Fixed in Bun 1.4.0; once the
 * repo moves to Bun >= 1.4, handle `upgrade` in the HTTP proxy and delete this.
 */
export const makeDockerUpgradeRouter = Effect.fnUntraced(function* ({
  dockerSocketPath,
  httpProxyPort,
}: {
  dockerSocketPath: string;
  httpProxyPort: number;
}) {
  const sockets = new Set<NodeStream.Duplex>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
    }),
  );
  const track = (socket: NodeStream.Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const connectUpstream = (headers: string): NodeStream.Duplex => {
    if (isTcpUpgrade(headers)) {
      return connectDockerSocket(dockerSocketPath.replace(/^unix:/, ""));
    }
    return NodeNet.createConnection({
      host: "127.0.0.1",
      port: httpProxyPort,
      allowHalfOpen: true,
    });
  };

  return NodeNet.createServer({ allowHalfOpen: true }, (client) => {
    // workerd closes stdin before it reads the output, so the client socket
    // must stay half-open. Bun 1.3 does not copy the server's allowHalfOpen
    // option onto accepted sockets.
    client.allowHalfOpen = true;
    track(client);
    client.on("error", () => client.destroy());

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headersEnd = buffered.indexOf("\r\n\r\n");
      if (headersEnd === -1) {
        if (buffered.length > MAX_HEADER_BYTES) client.destroy();
        return;
      }

      // Headers are complete: stop reading and hand the connection over.
      client.pause();
      client.removeListener("data", onData);

      const headers = buffered.subarray(0, headersEnd).toString();
      const upstream = connectUpstream(headers);
      track(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());

      // Replay everything read so far, then splice the two sockets.
      upstream.write(buffered);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on("data", onData);
  });
});
