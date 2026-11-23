import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

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
    }),
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
    }),
  );

  it.effect("closes all MCP sessions within one disconnect timeout during runtime cleanup", () =>
    Effect.gen(function* () {
      const deleteStarted = Promise.withResolvers<void>();
      const deleteResponse = Promise.withResolvers<Response>();
      const deleteSignals: AbortSignal[] = [];
      let nextConnectionId = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.sync(() => `connection-${++nextConnectionId}`),
        fetchImplementation: (_url, init) => {
          if (init?.method === "DELETE") {
            if (!init.signal) throw new Error("Missing cancellation signal");
            deleteSignals.push(init.signal);
            deleteStarted.resolve();
            return deleteResponse.promise;
          }
          const request = JSON.parse(String(init?.body)) as { readonly id: number };
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { protocolVersion: "2025-06-18" },
              }),
              {
                headers: {
                  "content-type": "application/json",
                  "mcp-session-id": `session-${nextConnectionId}`,
                },
              },
            ),
          );
        },
      });
      for (let index = 0; index < 16; index++) {
        const { connectionId } = yield* bridge.connect({ serverId: "t3-code" });
        yield* bridge.message({ connectionId, method: "initialize" });
      }
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(scope, bridge.dispose);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        yield* Effect.promise(() => deleteStarted.promise);
        yield* TestClock.adjust("5 seconds");
        expect(closing.pollUnsafe(), "All sessions must close within one timeout").toBeDefined();
        expect(deleteSignals).toHaveLength(16);
        expect(deleteSignals.every((signal) => signal.aborted)).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            deleteResponse.resolve(new Response(null, { status: 204 }));
            yield* Fiber.join(closing);
          }),
        ),
      );
    }),
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

  it.effect.each([
    {
      scenario: "reinitialize-and-stale-headers" as const,
      description:
        "re-initializes stateful MCP on setAuthorization and ignores stale in-flight session headers",
    },
    {
      scenario: "init-race-and-waiting-rejection" as const,
      description:
        "reconnects cleanly when auth rotates during initial initialize and rejects waiting calls from the prior generation",
    },
    {
      scenario: "error-and-malformed-initialize" as const,
      description:
        "fails reconnect when initialize returns an error or malformed envelope without sending notifications/initialized",
    },
  ])("$description", ({ scenario }) =>
    Effect.gen(function* () {
      const INIT_PARAMS = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "acp" },
      };
      const jsonResponse = (body: unknown, headers?: Record<string, string>) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", ...headers },
        });
      const makeStatefulBridge = (opts?: {
        readonly onRequest?: (
          auth: string | null,
          body: {
            readonly id?: unknown;
            readonly method: string;
            readonly params?: { readonly name?: string };
          },
        ) => Promise<Response | undefined>;
      }) =>
        Effect.gen(function* () {
          const seen: Array<{
            readonly authorization: string | null;
            readonly sessionId: string | null;
            readonly method: string;
          }> = [];
          let sessionCounter = 0;
          const sessionAuth = new Map<string, string>();
          const bridge = yield* makeAcpMcpOverAcpBridge({
            endpoint: "http://127.0.0.1:1/mcp",
            authorization: "Bearer run-1-token",
            allocateConnectionId: Effect.succeed(`conn-${scenario}`),
            fetchImplementation: async (_url, init) => {
              const headers = new Headers(init?.headers);
              const auth = headers.get("authorization");
              const incomingSid = headers.get("mcp-session-id");
              const body = JSON.parse(String(init?.body)) as {
                readonly id?: unknown;
                readonly method: string;
                readonly params?: { readonly name?: string };
              };
              seen.push({ authorization: auth, sessionId: incomingSid, method: body.method });
              const override = await opts?.onRequest?.(auth, body);
              if (override !== undefined) return override;
              if (body.method === "initialize") {
                const sid = `session-${++sessionCounter}`;
                sessionAuth.set(sid, auth ?? "");
                return jsonResponse(
                  {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
                  },
                  { "mcp-session-id": sid },
                );
              }
              // Stateful MCP 2025-06-18 rejects non-initialize requests without a valid session id.
              if (incomingSid === null || sessionAuth.get(incomingSid) !== auth) {
                return new Response("Mcp-Session-Id does not exist", { status: 400 });
              }
              if (body.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
              }
              return jsonResponse(
                { jsonrpc: "2.0", id: body.id, result: { content: [] } },
                { "mcp-session-id": incomingSid },
              );
            },
          });
          const { connectionId } = yield* bridge.connect({ serverId: "t3-code" });
          const init = () =>
            bridge.message({ connectionId, method: "initialize", params: INIT_PARAMS });
          const callTool = (name = "t3_submit_output") =>
            bridge.message({ connectionId, method: "tools/call", params: { name } });
          return { bridge, seen, init, callTool };
        });

      if (scenario === "reinitialize-and-stale-headers") {
        const slowCallStarted = Promise.withResolvers<void>();
        const releaseSlowCall = Promise.withResolvers<void>();
        const { bridge, seen, init, callTool } = yield* makeStatefulBridge({
          onRequest: async (_auth, body) => {
            if (body.params?.name === "slow_call") {
              slowCallStarted.resolve();
              await releaseSlowCall.promise;
            }
            return undefined;
          },
        });

        yield* init();
        const inFlight = yield* callTool("slow_call").pipe(Effect.forkChild);
        yield* Effect.promise(() => slowCallStarted.promise);

        // Rotate auth while generation-1 is in flight, establish session-2 first, then let generation-1 finish.
        bridge.setAuthorization("Bearer run-2-token");
        expect(yield* callTool()).toEqual({ content: [] });
        releaseSlowCall.resolve();
        yield* Fiber.join(inFlight);

        // A call after the late generation-1 response must still use session-2, not stale session-1.
        expect(yield* callTool()).toEqual({ content: [] });
        expect(seen).toEqual([
          { authorization: "Bearer run-1-token", sessionId: null, method: "initialize" },
          { authorization: "Bearer run-1-token", sessionId: "session-1", method: "tools/call" },
          { authorization: "Bearer run-2-token", sessionId: null, method: "initialize" },
          {
            authorization: "Bearer run-2-token",
            sessionId: "session-2",
            method: "notifications/initialized",
          },
          { authorization: "Bearer run-2-token", sessionId: "session-2", method: "tools/call" },
          { authorization: "Bearer run-2-token", sessionId: "session-2", method: "tools/call" },
        ]);
        return;
      }

      if (scenario === "init-race-and-waiting-rejection") {
        const initStarted = Promise.withResolvers<void>();
        const releaseInit = Promise.withResolvers<void>();
        const reconnect3Started = Promise.withResolvers<void>();
        const releaseReconnect3 = Promise.withResolvers<void>();
        const { bridge, seen, init, callTool } = yield* makeStatefulBridge({
          onRequest: async (auth, body) => {
            if (body.method === "initialize" && auth === "Bearer run-1-token") {
              initStarted.resolve();
              await releaseInit.promise;
            }
            if (body.method === "initialize" && auth === "Bearer run-3-token") {
              reconnect3Started.resolve();
              await releaseReconnect3.promise;
            }
            return undefined;
          },
        });

        // 1. Auth rotates while initial initialize is still in flight; subsequent call must reconnect.
        const initFiber = yield* init().pipe(Effect.forkChild);
        yield* Effect.promise(() => initStarted.promise);
        bridge.setAuthorization("Bearer run-2-token");
        releaseInit.resolve();
        yield* Fiber.join(initFiber);

        expect(yield* callTool("after_init_race")).toEqual({ content: [] });

        // 2. A gen-3 call waiting on reconnect while auth rotates to gen-4 is rejected before posting.
        bridge.setAuthorization("Bearer run-3-token");
        const waitingGen3 = yield* callTool().pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => reconnect3Started.promise);
        bridge.setAuthorization("Bearer run-4-token");
        releaseReconnect3.resolve();
        const rejected = yield* Fiber.join(waitingGen3);
        expect(rejected.message).toContain("rotated");
        // Verify run-4-token never received the stale waiting gen-3 t3_submit_output call.
        expect(seen.filter((entry) => entry.authorization === "Bearer run-4-token")).toEqual([]);
        return;
      }

      let nextInitMode: "ok" | "error" | "malformed" = "ok";
      const { bridge, seen, init, callTool } = yield* makeStatefulBridge({
        onRequest: async (_auth, body) => {
          if (body.method !== "initialize") return undefined;
          const mode = nextInitMode;
          nextInitMode = "ok";
          if (mode === "error") {
            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: "initialize rejected" },
            });
          }
          if (mode === "malformed") {
            return jsonResponse({ jsonrpc: "2.0", id: body.id });
          }
          return undefined;
        },
      });
      yield* init();
      bridge.setAuthorization("Bearer run-2-token");
      nextInitMode = "error";
      expect((yield* callTool().pipe(Effect.flip)).message).toContain("initialize rejected");
      nextInitMode = "malformed";
      expect((yield* callTool().pipe(Effect.flip)).message).toContain("valid initialize response");
      expect(seen.map((entry) => entry.method)).toEqual(["initialize", "initialize", "initialize"]);
      // Next call still retries reconnect because needsReconnect stayed true.
      expect(yield* callTool()).toEqual({ content: [] });
      expect(seen.map((entry) => entry.method)).toEqual([
        "initialize",
        "initialize",
        "initialize",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);

      // An agent-issued initialize with an error or malformed response does not clear needsReconnect.
      bridge.setAuthorization("Bearer run-3-token");
      nextInitMode = "error";
      expect((yield* init().pipe(Effect.flip)).message).toContain("initialize rejected");
      nextInitMode = "malformed";
      const explicitMalformed = yield* init().pipe(Effect.flip);
      expect(explicitMalformed._tag).toBe("AcpMcpOverAcpError");
      expect(explicitMalformed.message).toContain("valid initialize response");
      const methodsBeforeRecovery = seen.length;
      expect(yield* callTool()).toEqual({ content: [] });
      expect(seen.slice(methodsBeforeRecovery).map((entry) => entry.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
    }),
  );
});
