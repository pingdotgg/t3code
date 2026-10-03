// The bridge intentionally treats MCP JSON-RPC messages as opaque JSON.
// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeAcpMcpOverAcpBridge } from "./AcpMcpOverAcpBridge.ts";

describe("AcpMcpOverAcpBridge", () => {
  it.effect("forwards authenticated MCP requests and closes the negotiated session", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly method: string;
        readonly headers: Headers;
        readonly body: unknown;
      }> = [];
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body === undefined ? null : JSON.parse(String(init.body));
          requests.push({ method, headers, body });
          if (method === "DELETE") return new Response(null, { status: 204 });
          if (body === null || typeof body !== "object") return new Response(null, { status: 202 });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { tools: [] },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      const connected = yield* bridge.connect({ serverId: "t3-code" });
      expect(connected).toEqual({ connectionId: "connection-1" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "initialize" }),
      ).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "tools/list" }),
      ).toEqual({ tools: [] });
      yield* bridge.notification({
        connectionId: connected.connectionId,
        method: "notifications/initialized",
      });
      yield* bridge.disconnect({ connectionId: connected.connectionId });

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests.at(-1)?.method).toBe("DELETE");
      expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-42");
    }),
  );

  it.effect("aborts an in-flight HTTP request when the ACP call is interrupted", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<AbortSignal>();
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          if (!init?.signal) throw new Error("Missing cancellation signal");
          started.resolve(init.signal);
          return new Promise<Response>(() => {});
        },
      });
      const connected = yield* bridge.connect({ serverId: "t3-code" });
      const request = yield* bridge
        .message({ connectionId: connected.connectionId, method: "tools/list" })
        .pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      expect(signal.aborted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unknown servers, connections, and oversized messages", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
      });

      expect(yield* bridge.connect({ serverId: "other" }).pipe(Effect.flip)).toMatchObject({
        _tag: "AcpMcpOverAcpError",
      });
      expect(
        yield* bridge.message({ connectionId: "missing", method: "tools/list" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "AcpMcpOverAcpError" });

      const connected = yield* bridge.connect({ serverId: "t3-code" });
      const failure = yield* bridge
        .message({
          connectionId: connected.connectionId,
          method: "tools/call",
          params: { payload: "x".repeat(8 * 1024 * 1024) },
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("exceeds 8 MiB");
    }),
  );

  it.effect("caps concurrent connects at 16 and reuses a freed slot", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let nextId = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.suspend(() => {
          const connectionId = `connection-${++nextId}`;
          if (nextId !== 1) return Effect.succeed(connectionId);
          return Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.as(connectionId),
          );
        }),
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
      });

      expect(yield* bridge.connect({ serverId: "other" }).pipe(Effect.flip)).toMatchObject({
        _tag: "AcpMcpOverAcpError",
      });

      const first = yield* bridge
        .connect({ serverId: "t3-code" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstEntered);
      const rest = yield* Effect.all(
        Array.from({ length: 16 }, () =>
          bridge
            .connect({ serverId: "t3-code" })
            .pipe(Effect.forkChild({ startImmediately: true })),
        ),
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(releaseFirst, undefined);

      const outcomes = yield* Effect.forEach([first, ...rest], (fiber) =>
        Fiber.join(fiber).pipe(Effect.result),
      );
      const successes = outcomes.filter((outcome) => outcome._tag === "Success");
      const failures = outcomes.filter((outcome) => outcome._tag === "Failure");
      expect(successes).toHaveLength(16);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        failure: {
          _tag: "AcpMcpOverAcpError",
          message: "Too many MCP-over-ACP connections.",
        },
      });

      const connectionIds = successes.flatMap((outcome) =>
        outcome._tag === "Success" ? [outcome.success.connectionId] : [],
      );
      expect(new Set(connectionIds).size).toBe(16);
      yield* bridge.disconnect({ connectionId: connectionIds[0]! });
      const replacement = yield* bridge.connect({ serverId: "t3-code" });
      expect(connectionIds).not.toContain(replacement.connectionId);
      expect(yield* bridge.connect({ serverId: "t3-code" }).pipe(Effect.flip)).toMatchObject({
        _tag: "AcpMcpOverAcpError",
        message: "Too many MCP-over-ACP connections.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not consume a slot when connection allocation is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let nextId = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.suspend(() => {
          const connectionId = `connection-${++nextId}`;
          if (nextId !== 1) return Effect.succeed(connectionId);
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(proceed)),
            Effect.as(connectionId),
          );
        }),
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
      });

      const hung = yield* bridge
        .connect({ serverId: "t3-code" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(hung);

      const connected = yield* Effect.all(
        Array.from({ length: 16 }, () => bridge.connect({ serverId: "t3-code" })),
      );
      expect(connected).toHaveLength(16);
      expect(yield* bridge.connect({ serverId: "t3-code" }).pipe(Effect.flip)).toMatchObject({
        _tag: "AcpMcpOverAcpError",
        message: "Too many MCP-over-ACP connections.",
      });
    }).pipe(Effect.scoped),
  );
});
