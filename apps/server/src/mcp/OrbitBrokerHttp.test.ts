import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrbitBroker from "./OrbitBroker.ts";
import { OrbitToolkit } from "./toolkits/orbit/tools.ts";
import * as OrbitHandlers from "./toolkits/orbit/handlers.ts";

it.effect(
  "reauthenticates every Orbit call on an open MCP session, including expiry, trusted resume and revocation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let now = 1000;
        const registry = yield* McpSessionRegistry.__testing
          .make({ now: () => now, livenessWindowMs: 100 })
          .pipe(
            Effect.provideService(
              ServerEnvironment.ServerEnvironment,
              ServerEnvironment.ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                getDescriptor: Effect.die("unused"),
              }),
            ),
          );
        const issue = (id: string) =>
          registry.issue({
            threadId: ThreadId.make(id),
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
        const one = yield* issue("one");
        const two = yield* issue("two");
        const seen: string[] = [];
        const broker = OrbitBroker.OrbitBroker.of({
          invoke: () =>
            Effect.gen(function* () {
              const scope = yield* McpInvocationContext.McpInvocationContext;
              seen.push(scope.thread!.threadId);
              return { threadId: scope.thread!.threadId };
            }),
        });
        yield* HttpRouter.serve(
          McpHttpServer.layerMcpTransport(
            McpHttpServer.toolkitRegistration(OrbitToolkit, OrbitHandlers.layer).pipe(
              Layer.provide(Layer.succeed(OrbitBroker.OrbitBroker, broker)),
            ),
          ).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);
        const http = yield* HttpClient.HttpClient;
        const send = (authorization: string, session: string | undefined, method = "tools/call") =>
          http.post("/mcp", {
            headers: {
              authorization,
              accept: "application/json, text/event-stream",
              "x-t3-thread-id": "orchestrator",
              ...(session === undefined
                ? {}
                : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
            },
            body: HttpBody.text(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params:
                  method === "initialize"
                    ? {
                        protocolVersion: "2025-06-18",
                        capabilities: {},
                        clientInfo: { name: "orbit-test", version: "1" },
                      }
                    : { name: "orbit", arguments: { operation: "orbit_context" } },
              }),
              "application/json",
            ),
          });
        const initialized = yield* send(one.config.authorizationHeader, undefined, "initialize");
        const session = initialized.headers["mcp-session-id"]!;
        expect((yield* send(one.config.authorizationHeader, session)).status).toBe(200);
        expect(seen).toEqual(["one"]);
        const foreignSession = yield* send(two.config.authorizationHeader, session);
        expect(foreignSession.status).toBe(404);
        expect(seen).toEqual(["one"]);
        now += 101;
        expect((yield* send(one.config.authorizationHeader, session)).status).toBe(401);
        yield* registry.touch(ThreadId.make("one"));
        expect((yield* send(one.config.authorizationHeader, session)).status).toBe(200);
        expect(seen).toEqual(["one", "one"]);
        yield* registry.revokeProviderSession(one.config.providerSessionId);
        yield* registry.touch(ThreadId.make("one"));
        expect((yield* send(one.config.authorizationHeader, session)).status).toBe(401);
        const resumed = yield* issue("one");
        const fresh = yield* send(resumed.config.authorizationHeader, undefined, "initialize");
        expect(
          (yield* send(resumed.config.authorizationHeader, fresh.headers["mcp-session-id"]!))
            .status,
        ).toBe(200);
        yield* registry.revokeThread(ThreadId.make("one"));
        expect(
          (yield* send(resumed.config.authorizationHeader, fresh.headers["mcp-session-id"]!))
            .status,
        ).toBe(401);
        expect((yield* send("Bearer shared-install-token", session)).status).toBe(401);
        expect(seen).toEqual(["one", "one", "one"]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
);

it.effect.each([
  [{}, false],
  [{ T3CODE_ORBIT_BROKER_TOKEN_FILE: "" }, false],
  [{ T3CODE_ORBIT_BROKER_TOKEN_FILE: "/private/broker-token" }, true],
] as const)("advertises the orbit tool only when the broker is configured: %j", ([env, listed]) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    expect(mcp.tools.some(({ tool }) => tool.name === "orbit")).toBe(listed);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrbitToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            McpProviderSessions.layer,
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ServerEnvironment.ServerEnvironment)({}),
          ),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    ),
  ),
);
