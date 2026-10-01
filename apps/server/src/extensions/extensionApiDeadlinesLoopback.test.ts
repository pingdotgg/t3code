// @effect-diagnostics nodeBuiltinImport:off - the client talks to a real loopback HTTP server.
/**
 * Client-side extension API deadlines over native fetch. This lives in the
 * server package because client-runtime is shared with web and mobile and has
 * no Node types; the stubbed-fetch variants stay in client-runtime.
 */
import * as NodeHttp from "node:http";
import { describe, it, expect } from "@effect/vitest";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { environmentExtensionsHttp } from "@t3tools/client-runtime/state/extensions";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

interface HeldRequest {
  readonly url: string | undefined;
  readonly body: string;
  readonly response: NodeHttp.ServerResponse;
  readonly closed: Promise<void>;
}

/** A server that records each request and answers only when the test says so. */
const loopback = Effect.acquireRelease(
  Effect.promise(async () => {
    const held: HeldRequest[] = [];
    let arrived!: () => void;
    const firstArrived = new Promise<void>((resolve) => (arrived = resolve));
    const server = NodeHttp.createServer((req, res) => {
      const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        held.push({
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          response: res,
          closed,
        });
        arrived();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    const httpBaseUrl = `http://127.0.0.1:${address.port}`;
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("env"),
      label: "Loopback",
      httpBaseUrl,
      wsBaseUrl: `ws://127.0.0.1:${address.port}`,
    });
    const connection: PreparedConnection = {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl,
      socketUrl: `ws://127.0.0.1:${address.port}/ws`,
      httpAuthorization: null,
      target,
    };
    return { server, held, firstArrived, connection };
  }),
  ({ server }) =>
    Effect.promise(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

const nativeFetch = remoteHttpClientLayer(globalThis.fetch);

const invocation = (method: string) => ({
  installationId: "example.browser",
  expectedContentHash: "a".repeat(64),
  request: {
    id: "t3.browser/profiles",
    versionRange: "^1.0.0",
    method,
    input: {},
    context: {
      resource: { namespace: "t3.thread", id: "thread", environmentId: EnvironmentId.make("env") },
      client: "web" as const,
    },
  },
});

describe("extension API invocation deadlines over loopback HTTP", () => {
  it.effect("cookie import receives a response delayed past the default deadline", () =>
    Effect.gen(function* () {
      const server = yield* loopback;
      const fiber = yield* environmentExtensionsHttp
        .invokeApi(server.connection, invocation("importCookies"))
        .pipe(Effect.provide(nativeFetch), Effect.forkChild);
      yield* Effect.promise(() => server.firstArrived);
      const request = server.held[0]!;
      expect(request.url).toBe("/api/extensions/api/invoke");
      expect(request.body).toContain('"method":"importCookies"');
      // Just inside the server broker's import deadline (5 min wait + 30s).
      yield* TestClock.adjust("329 seconds");
      request.response.writeHead(200, { "content-type": "application/json" });
      request.response.end('{"result":{"imported":3}}');
      const result = yield* Fiber.join(fiber);
      expect(result.result).toEqual({ imported: 3 });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an ordinary method times out and abandons the stalled request", () =>
    Effect.gen(function* () {
      const server = yield* loopback;
      const fiber = yield* environmentExtensionsHttp
        .invokeApi(server.connection, invocation("listImportSources"))
        .pipe(Effect.provide(nativeFetch), Effect.result, Effect.forkChild);
      yield* Effect.promise(() => server.firstArrived);
      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure._tag).toBe("RemoteEnvironmentAuthTimeoutError");
      // The timeout aborts the real fetch, so the server sees the socket close.
      yield* Effect.promise(() => server.held[0]!.closed);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
