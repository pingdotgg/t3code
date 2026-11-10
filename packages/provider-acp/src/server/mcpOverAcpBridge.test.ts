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
      yield* bridge.disconnect({ connectionId: connected.connectionId });

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

  it.effect("answers current-draft messages by serverId with a result or error outcome", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          const request = JSON.parse(String(init?.body)) as {
            readonly id?: unknown;
            readonly method?: unknown;
          };
          const outcome =
            request.method === "initialize"
              ? { result: { protocolVersion: "2025-06-18" } }
              : { error: { code: -32602, message: "Unknown tool" } };
          return Promise.resolve(
            new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome }), {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            }),
          );
        },
      });
      const message = (method: string, requestId: string) =>
        bridge.message({ serverId: "t3-code", requestId, method });

      expect(yield* message("initialize", "mcp-1")).toEqual({
        result: { protocolVersion: "2025-06-18" },
      });
      expect(yield* message("tools/call", "mcp-2")).toEqual({
        error: { code: -32602, message: "Unknown tool" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns an endpoint rejection's JSON-RPC error so the agent can fall back", () =>
    Effect.gen(function* () {
      const unsupported = {
        code: -32022,
        message: "Unsupported protocol version '2026-07-28'",
        data: { supported: ["2025-06-18"], requested: "2026-07-28" },
      };
      const requests: Array<{ readonly method: unknown; readonly headers: Headers }> = [];
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          const request = JSON.parse(String(init?.body)) as {
            readonly id?: unknown;
            readonly method?: unknown;
          };
          requests.push({ method: request.method, headers: new Headers(init?.headers) });
          const reply = (outcome: object, init: ResponseInit) =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome }), {
              ...init,
              headers: { "content-type": "application/json", ...init.headers },
            });
          if (request.method === "server/discover") {
            return Promise.resolve(reply({ error: unsupported }, { status: 400 }));
          }
          return Promise.resolve(
            reply(
              {
                result:
                  request.method === "initialize"
                    ? { protocolVersion: "2025-06-18" }
                    : { tools: [] },
              },
              { headers: { "mcp-session-id": "session-42" } },
            ),
          );
        },
      });
      const message = (method: string, requestId: string) =>
        bridge.message({ serverId: "t3-code", requestId, method });

      expect(yield* message("server/discover", "mcp-1")).toEqual({ error: unsupported });
      expect(yield* message("initialize", "mcp-2")).toEqual({
        result: { protocolVersion: "2025-06-18" },
      });
      expect(yield* message("tools/list", "mcp-3")).toEqual({ result: { tools: [] } });
      expect(requests.map((request) => request.headers.get("mcp-session-id"))).toEqual([
        null,
        null,
        "session-42",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("opens a new MCP session when a current-draft agent initializes again", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly verb: string;
        readonly method: unknown;
        readonly sessionId: string | null;
      }> = [];
      let sessions = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          const verb = init?.method ?? "GET";
          const sessionId = new Headers(init?.headers).get("mcp-session-id");
          const request =
            verb === "DELETE"
              ? {}
              : (JSON.parse(String(init?.body)) as {
                  readonly id?: unknown;
                  readonly method?: unknown;
                });
          requests.push({ verb, method: request.method, sessionId });
          if (verb === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
          const reply = (outcome: object, headers: Record<string, string> = {}, status = 200) =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome }), {
              status,
              headers: { "content-type": "application/json", ...headers },
            });
          if (request.method !== "initialize") {
            return Promise.resolve(reply({ result: { tools: [] } }));
          }
          // The MCP endpoint refuses an initialize that carries an existing session.
          if (sessionId !== null) {
            return Promise.resolve(
              reply(
                {
                  error: {
                    code: -32600,
                    message: "initialize must not include an MCP-Session-Id header",
                  },
                },
                {},
                400,
              ),
            );
          }
          return Promise.resolve(
            reply(
              { result: { protocolVersion: "2025-06-18" } },
              { "mcp-session-id": `session-${++sessions}` },
            ),
          );
        },
      });
      const message = (method: string, requestId: string) =>
        bridge.message({ serverId: "t3-code", requestId, method });

      yield* message("initialize", "mcp-1");
      yield* bridge.notification({
        serverId: "t3-code",
        requestId: "mcp-n",
        method: "notifications/initialized",
      });
      yield* message("tools/list", "mcp-2");
      expect(yield* message("initialize", "mcp-3")).toEqual({
        result: { protocolVersion: "2025-06-18" },
      });
      yield* message("tools/list", "mcp-4");
      yield* bridge.dispose;

      expect(requests).toEqual([
        { verb: "POST", method: "initialize", sessionId: null },
        { verb: "POST", method: "notifications/initialized", sessionId: "session-1" },
        { verb: "POST", method: "tools/list", sessionId: "session-1" },
        { verb: "DELETE", method: undefined, sessionId: "session-1" },
        { verb: "POST", method: "initialize", sessionId: null },
        { verb: "POST", method: "tools/list", sessionId: "session-2" },
        { verb: "DELETE", method: undefined, sessionId: "session-2" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each initialize on its own session while the replaced one is closing", () =>
    Effect.gen(function* () {
      const deleteStarted = Promise.withResolvers<void>();
      const deleteResponse = Promise.withResolvers<void>();
      let sessions = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          const sessionId = new Headers(init?.headers).get("mcp-session-id");
          if (init?.method === "DELETE") {
            if (sessionId === "session-1") {
              deleteStarted.resolve();
              await deleteResponse.promise;
            }
            return new Response(null, { status: 204 });
          }
          const request = JSON.parse(String(init?.body)) as { readonly id?: unknown };
          // The MCP endpoint refuses an initialize that carries an existing session.
          const outcome =
            sessionId === null
              ? { result: { protocolVersion: "2025-06-18" } }
              : { error: { code: -32600, message: "initialize must not include a session" } };
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome }), {
            status: sessionId === null ? 200 : 400,
            headers: {
              "content-type": "application/json",
              ...(sessionId === null ? { "mcp-session-id": `session-${++sessions}` } : {}),
            },
          });
        },
      });
      const initialize = (requestId: string) =>
        bridge.message({ serverId: "t3-code", requestId, method: "initialize" });
      const initialized = { result: { protocolVersion: "2025-06-18" } };

      yield* initialize("mcp-1");
      const waiting = yield* initialize("mcp-2").pipe(Effect.forkChild);
      yield* Effect.promise(() => deleteStarted.promise);
      expect(yield* initialize("mcp-3")).toEqual(initialized);
      deleteResponse.resolve();
      expect(yield* Fiber.join(waiting)).toEqual(initialized);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the session of an initialize still in flight when disposed", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const respond = Promise.withResolvers<void>();
      const deleted: Array<string | null> = [];
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          if (init?.method === "DELETE") {
            deleted.push(new Headers(init.headers).get("mcp-session-id"));
            return new Response(null, { status: 204 });
          }
          const request = JSON.parse(String(init?.body)) as { readonly id?: unknown };
          started.resolve();
          await respond.promise;
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { protocolVersion: "2025-06-18" },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
          );
        },
      });

      const initialize = yield* bridge
        .message({ serverId: "t3-code", requestId: "mcp-1", method: "initialize" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* bridge.dispose;
      respond.resolve();
      yield* Fiber.join(initialize);
      expect(deleted).toEqual(["session-1"]);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the session of a replaced initialize even when that initialize fails", () =>
    Effect.gen(function* () {
      const firstStarted = Promise.withResolvers<void>();
      const firstResponse = Promise.withResolvers<void>();
      const deleted: Array<string | null> = [];
      let sessions = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          if (init?.method === "DELETE") {
            deleted.push(new Headers(init.headers).get("mcp-session-id"));
            return new Response(null, { status: 204 });
          }
          const request = JSON.parse(String(init?.body)) as { readonly id?: unknown };
          const sessionId = `session-${++sessions}`;
          if (sessionId === "session-1") {
            firstStarted.resolve();
            await firstResponse.promise;
            // The endpoint opened a session but the response carries no JSON-RPC answer.
            return new Response("upstream failure", {
              status: 500,
              headers: { "mcp-session-id": sessionId },
            });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { protocolVersion: "2025-06-18" },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": sessionId } },
          );
        },
      });
      const initialize = (requestId: string) =>
        bridge.message({ serverId: "t3-code", requestId, method: "initialize" });

      const first = yield* initialize("mcp-1").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => firstStarted.promise);
      yield* initialize("mcp-2");
      firstResponse.resolve();
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: "AcpMcpOverAcpError" });
      expect(deleted).toEqual(["session-1"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects unknown servers, connections, endpoint rejections, and oversized messages",
    () =>
      Effect.gen(function* () {
        const bridge = yield* makeAcpMcpOverAcpBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          allocateConnectionId: Effect.succeed("connection-1"),
          fetchImplementation: (_url, init) => {
            const { id } = JSON.parse(String(init?.body)) as { readonly id?: unknown };
            const error = { code: -32020, message: "MCP-Protocol-Version header is required" };
            return Promise.resolve(
              new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
                status: 400,
                headers: { "content-type": "application/json" },
              }),
            );
          },
        });

        expect(yield* bridge.connect({ serverId: "other" }).pipe(Effect.flip)).toMatchObject({
          _tag: "AcpMcpOverAcpError",
        });
        expect(
          yield* bridge
            .message({ serverId: "other", requestId: "mcp-1", method: "tools/list" })
            .pipe(Effect.flip),
        ).toMatchObject({ message: 'Unknown ACP MCP server "other".' });
        expect(
          yield* bridge
            .message({ connectionId: "missing", method: "tools/list" })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "AcpMcpOverAcpError" });

        const connected = yield* bridge.connect({ serverId: "t3-code" });
        expect(
          yield* bridge
            .message({ connectionId: connected.connectionId, method: "tools/list" })
            .pipe(Effect.flip),
        ).toMatchObject({ message: "MCP-Protocol-Version header is required" });
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
