// @effect-diagnostics nodeBuiltinImport:off - Effect has no HTTP forward proxy or address block list.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

/** This machine and its local networks, which HTML previews must never reach. */
const LOCAL_ADDRESSES = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  LOCAL_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

/**
 * The public address to connect to for `host`, or undefined when any address
 * it resolves to is local. The caller connects to the address checked here,
 * so a name that later resolves elsewhere (DNS rebinding) changes nothing.
 */
const publicAddress = async (host: string) => {
  const bare = host.replace(/^\[|\]$/g, "");
  const addresses = NodeNet.isIP(bare)
    ? [{ address: bare, family: NodeNet.isIP(bare) }]
    : await NodeDnsPromises.lookup(bare, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  const local = addresses.some(({ address, family }) =>
    LOCAL_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4"),
  );
  return local ? undefined : addresses[0]!.address;
};

/** `host:port` from a CONNECT target, including bracketed IPv6. */
const splitTarget = (target: string) => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
  return match ? { host: match[1]!, port: Number(match[2]) } : undefined;
};

const refuse = (response: NodeHttp.ServerResponse) => {
  response.writeHead(403).end();
};

/**
 * Starts a forward proxy on loopback for the life of the scope and returns
 * its port. It carries the preview browser's plain HTTP requests and HTTPS
 * tunnels to public addresses only. Chrome's Local Network Access misses some
 * requests, such as speculation-rules prefetches, and every request passes
 * through here.
 */
export const publicProxy = Effect.acquireRelease(
  Effect.callback<NodeHttp.Server>((resume) => {
    const server = NodeHttp.createServer((request, response) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "");
      } catch {
        return refuse(response);
      }
      if (url.protocol !== "http:") return refuse(response);
      void publicAddress(url.hostname).then((address) => {
        if (address === undefined) return refuse(response);
        const upstream = NodeHttp.request(
          {
            host: address,
            port: url.port || 80,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers: { ...request.headers, host: url.host },
            setHost: false,
          },
          (reply) => {
            response.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(response);
          },
        );
        upstream.on("error", () => response.destroy());
        request.pipe(upstream);
      });
    });
    server.on("connect", (request: NodeHttp.IncomingMessage, client: NodeNet.Socket, head) => {
      client.on("error", () => client.destroy());
      const target = splitTarget(request.url ?? "");
      if (target === undefined) return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      void publicAddress(target.host).then((address) => {
        if (address === undefined) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        const upstream = NodeNet.connect(target.port, address, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);
