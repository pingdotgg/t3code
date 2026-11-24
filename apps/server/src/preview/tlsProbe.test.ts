// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- the test drives real TLS and plain servers; the dribble server ticks in a plain Node callback, outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";

import { probeTlsListener } from "./tlsProbe.ts";

const cert = NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
const key = NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));

const listen = (server: NodeHttp.Server | NodeHttps.Server) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      }),
  );

const withServer = <A, E, R>(
  make: () => NodeHttp.Server | NodeHttps.Server,
  use: (port: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(make),
    (server) => listen(server).pipe(Effect.flatMap(use)),
    (server) => Effect.sync(() => server.close()),
  );

const listenOnHost = (server: NodeNet.Server, host: string) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve) => {
        server.listen(0, host, () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      }),
  );

effectIt.live("detects a TLS listener with a self-signed certificate", () =>
  withServer(
    () =>
      NodeHttps.createServer({ key, cert }, (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("ok");
      }),
    (port) =>
      Effect.gen(function* () {
        expect(yield* probeTlsListener({ host: "localhost", port })).toBe(true);
      }),
  ),
);

effectIt.live("answers false for a plain HTTP listener", () =>
  withServer(
    () =>
      NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("ok");
      }),
    (port) =>
      Effect.gen(function* () {
        expect(yield* probeTlsListener({ host: "localhost", port })).toBe(false);
      }),
  ),
);

effectIt.effect("never probes a non-loopback host", () =>
  Effect.gen(function* () {
    expect(yield* probeTlsListener({ host: "example.com", port: 443 })).toBe(false);
    expect(yield* probeTlsListener({ host: "192.168.1.25", port: 3000 })).toBe(false);
  }),
);

effectIt.live("accepts a bracketed IPv6 loopback host", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeHttps.createServer({ key, cert }, (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("ok");
      }),
    ),
    (server) =>
      listenOnHost(server, "::1").pipe(
        Effect.flatMap((port) =>
          Effect.gen(function* () {
            expect(yield* probeTlsListener({ host: "[::1]", port })).toBe(true);
          }),
        ),
      ),
    (server) => Effect.sync(() => server.close()),
  ),
);

effectIt.live("applies a total handshake deadline when fragments keep arriving", () => {
  const server = NodeNet.createServer((socket) => {
    // Dribble one byte at a time: each byte resets an inactivity timer, but no
    // complete handshake record ever arrives, so only a total deadline ends this.
    const timer = setInterval(() => socket.write(Buffer.from([0x16])), 900);
    socket.on("close", () => clearInterval(timer));
    socket.on("error", () => clearInterval(timer));
  });
  return Effect.acquireUseRelease(
    listenOnHost(server, "127.0.0.1"),
    (port) =>
      probeTlsListener({ host: "127.0.0.1", port }).pipe(
        Effect.timeoutOption(Duration.seconds(3)),
        Effect.map((result) => {
          expect(result).toEqual(Option.some(false));
        }),
      ),
    () => Effect.sync(() => server.close()),
  );
});
