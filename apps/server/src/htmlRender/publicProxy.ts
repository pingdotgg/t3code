// @effect-diagnostics nodeBuiltinImport:off - Effect has no SOCKS proxy or address block list.
import * as NodeDnsPromises from "node:dns/promises";
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
  const addresses = NodeNet.isIP(host)
    ? [{ address: host, family: NodeNet.isIP(host) }]
    : await NodeDnsPromises.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return undefined;
  const local = addresses.some(({ address, family }) =>
    LOCAL_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4"),
  );
  return local ? undefined : addresses[0]!.address;
};

// SOCKS5 (RFC 1928) replies: success, refused by rule, host unreachable, command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** The CONNECT target in a complete SOCKS5 request, or "short" when more bytes are needed. */
const readRequest = (data: Buffer) => {
  if (data.length < 5) return "short" as const;
  const type = data[3];
  const end = type === 1 ? 10 : type === 3 ? 7 + data[4]! : type === 4 ? 22 : -1;
  if (end === -1) return undefined;
  if (data.length < end) return "short" as const;
  const host =
    type === 1
      ? [...data.subarray(4, 8)].join(".")
      : type === 3
        ? data.subarray(5, 5 + data[4]!).toString("latin1")
        : Array.from({ length: 8 }, (_, index) =>
            data.readUInt16BE(4 + index * 2).toString(16),
          ).join(":");
  return { command: data[1], host, port: data.readUInt16BE(end - 2), rest: data.subarray(end) };
};

/**
 * Starts a SOCKS5 proxy on loopback for the life of the scope and returns its
 * port. The preview browser sends every connection through it, and it only
 * connects to public addresses. Chrome's Local Network Access misses some
 * requests, such as speculation-rules prefetches; nothing misses this. It
 * carries bytes only, so HTTP, TLS, and WebSockets pass through unchanged.
 */
export const publicProxy = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> }>(
    (resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const track = (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        return socket;
      };
      const server = NodeNet.createServer((client) => {
        track(client);
        let data = Buffer.alloc(0);
        let greeted = false;
        const onData = (chunk: Buffer) => {
          data = Buffer.concat([data, chunk]);
          if (!greeted) {
            if (data.length < 2 || data.length < 2 + data[1]!) return;
            // Version 5, offering "no authentication".
            if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) {
              return void client.end(Buffer.from([5, 0xff]));
            }
            data = data.subarray(2 + data[1]!);
            greeted = true;
            client.write(Buffer.from([5, 0]));
          }
          const request = readRequest(data);
          if (request === "short") return;
          client.off("data", onData);
          client.pause();
          if (request === undefined || request.command !== 1 || request.port === 0) {
            return void client.end(reply(7));
          }
          void publicAddress(request.host).then((address) => {
            if (address === undefined) return void client.end(reply(2));
            if (client.destroyed) return;
            const upstream = track(NodeNet.connect(request.port, address));
            upstream.once("connect", () => {
              client.write(reply(0));
              upstream.write(request.rest);
              upstream.pipe(client);
              client.pipe(upstream);
              client.resume();
            });
            upstream.on("close", () => client.destroy());
            client.on("close", () => upstream.destroy());
          });
        };
        client.on("data", onData);
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
    },
  ),
  ({ server, sockets }) =>
    Effect.callback<void>((resume) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map(({ server }) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);
