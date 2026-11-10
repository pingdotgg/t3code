import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeAcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";

describe("AcpMcpOverAcpBridge", () => {
  it.effect("forwards authenticated MCP requests and closes the negotiated session", () =>
    Effect.gen(function* () {
      const initializeStarted = Promise.withResolvers<void>();
      const initializeResponse = Promise.withResolvers<void>();
      const listQueued = Promise.withResolvers<void>();
      const deleteStarted = Promise.withResolvers<void>();
      const deleteResponse = Promise.withResolvers<void>();
      const requests: Array<{
        readonly method: string;
        readonly headers: Headers;
        readonly body: unknown;
      }> = [];
      let deletes = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body === undefined ? null : JSON.parse(String(init.body));
          requests.push({ method, headers, body });
          if (method === "DELETE") {
            if (++deletes > 1) return new Response(null, { status: 204 });
            deleteStarted.resolve();
            await deleteResponse.promise;
            return new Response(null, { status: 503 });
          }
          if (body === null || typeof body !== "object") return new Response(null, { status: 202 });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "initialize") {
            initializeStarted.resolve();
            await initializeResponse.promise;
          }
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
      const initialize = yield* bridge
        .message({ connectionId: connected.connectionId, method: "initialize" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => initializeStarted.promise);
      const list = yield* Effect.gen(function* () {
        listQueued.resolve();
        return yield* bridge.message({
          connectionId: connected.connectionId,
          method: "tools/list",
        });
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => listQueued.promise);
      initializeResponse.resolve();
      expect(yield* Fiber.join(initialize)).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(yield* Fiber.join(list)).toEqual({ tools: [] });
      yield* bridge.notification({
        connectionId: connected.connectionId,
        method: "notifications/initialized",
      });
      // Calls during a close are refused; a rejected close restores the connection for a retry.
      const rejected = yield* bridge
        .disconnect({ connectionId: connected.connectionId })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => deleteStarted.promise);
      const closing = yield* bridge
        .message({ connectionId: connected.connectionId, method: "tools/list" })
        .pipe(Effect.flip);
      expect(closing.message).toContain("Unknown MCP-over-ACP connection");
      deleteResponse.resolve();
      expect((yield* Fiber.join(rejected)).message).toContain("HTTP 503");
      yield* bridge.disconnect({ connectionId: connected.connectionId });
      expect(deletes).toBe(2);

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests.at(-1)?.method).toBe("DELETE");
      expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-42");
    }).pipe(Effect.scoped),
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

  it.effect("answers a call while a long call on the same connection is pending", () =>
    Effect.gen(function* () {
      const waitStarted = Promise.withResolvers<void>();
      const waitResponse = Promise.withResolvers<Response>();
      const reply = (id: unknown, result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
        });
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          const request = JSON.parse(String(init?.body)) as {
            readonly id?: unknown;
            readonly method?: unknown;
          };
          if (request.method === "initialize") {
            return Promise.resolve(reply(request.id, { protocolVersion: "2025-06-18" }));
          }
          if (request.method === "tools/call") {
            waitStarted.resolve();
            return waitResponse.promise;
          }
          return Promise.resolve(reply(request.id, { tools: [] }));
        },
      });
      const { connectionId } = yield* bridge.connect({ serverId: "t3-code" });
      yield* bridge.message({ connectionId, method: "initialize" });

      const wait = yield* bridge
        .message({ connectionId, method: "tools/call", params: { name: "t3_thread_wait" } })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => waitStarted.promise);
      expect(yield* bridge.message({ connectionId, method: "tools/list" })).toEqual({ tools: [] });

      waitResponse.resolve(reply(2, { content: [] }));
      expect(yield* Fiber.join(wait)).toEqual({ content: [] });
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
});
