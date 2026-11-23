// @effect-diagnostics nodeBuiltinImport:off -- the test drives real TLS and plain servers.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

const freePort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as NodeNet.AddressInfo).port;
        server.close(() => resolve(port));
      });
    }),
);

effectIt.effect("detects a TLS listener with a self-signed certificate", () =>
  withServer(
    () =>
      NodeHttps.createServer({ key, cert }, (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("ok");
      }),
    (port) =>
      Effect.gen(function* () {
        expect(yield* probeTlsListener({ host: "localhost", port })).toBe(true);
        expect(yield* probeTlsListener({ host: "127.0.0.1", port })).toBe(true);
      }),
  ),
);

effectIt.effect("answers false for a plain HTTP listener and a closed port", () =>
  withServer(
    () =>
      NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("ok");
      }),
    (port) =>
      Effect.gen(function* () {
        expect(yield* probeTlsListener({ host: "localhost", port })).toBe(false);
        const closed = yield* freePort;
        expect(yield* probeTlsListener({ host: "localhost", port: closed })).toBe(false);
      }),
  ),
);

effectIt.effect("never probes a non-loopback host", () =>
  Effect.gen(function* () {
    expect(yield* probeTlsListener({ host: "example.com", port: 443 })).toBe(false);
    expect(yield* probeTlsListener({ host: "192.168.1.25", port: 3000 })).toBe(false);
  }),
);
