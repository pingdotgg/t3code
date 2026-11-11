import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
const Probe = Tool.make("probe", {
  description: "Read authenticated scope",
  parameters: Tool.EmptyParams,
  success: Schema.Unknown,
  dependencies: [McpInvocationContext.McpInvocationContext],
});
const ProbeToolkit = Toolkit.make(Probe);

it.effect(
  "reauthenticates every tool call on an open MCP session, including expiry, trusted resume and revocation",
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
        const handlers = McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            Effect.gen(function* () {
              const scope = yield* McpInvocationContext.McpInvocationContext;
              seen.push(scope.thread!.threadId);
              return { threadId: scope.thread!.threadId };
            }),
          ),
        });
        yield* HttpRouter.serve(
          McpHttpServer.layerMcpTransport(
            McpHttpServer.toolkitRegistration(ProbeToolkit, handlers),
          ).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              Layer.succeed(McpHttpServer.McpClientAuthenticator, {
                authenticate: (request) =>
                  Effect.succeed(
                    request.headers.authorization?.startsWith("Bearer client-")
                      ? {
                          environmentId: EnvironmentId.make("environment"),
                          requestNamespace: request.headers.authorization.slice(7),
                          issuedAt: 1,
                          thread: undefined,
                          client: {
                            sessionId: request.headers.authorization.slice(7),
                            label: "test",
                            access: "full-access" as const,
                          },
                          capabilities: new Set(["orchestration"] as const),
                        }
                      : undefined,
                  ),
              }),
            ),
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
                        clientInfo: { name: "scope-test", version: "1" },
                      }
                    : { name: "probe", arguments: {} },
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
        const requestSession = (method: "GET" | "DELETE", authorization: string, id: string) =>
          http.execute(
            HttpClientRequest.make(method)("/mcp").pipe(
              HttpClientRequest.setHeaders({
                authorization,
                accept: "text/event-stream",
                "mcp-session-id": id,
                "mcp-protocol-version": "2025-06-18",
              }),
            ),
          );
        for (const method of ["GET", "DELETE"] as const)
          expect(
            (yield* requestSession(method, two.config.authorizationHeader, session)).status,
          ).toBe(404);
        let reconnectedSession = "";
        for (let i = 0; i < 64; i++) {
          const initialized = yield* send(two.config.authorizationHeader, undefined, "initialize");
          reconnectedSession = initialized.headers["mcp-session-id"]!;
          expect(initialized.status).toBe(200);
        }
        expect((yield* send(two.config.authorizationHeader, undefined, "initialize")).status).toBe(
          200,
        );
        expect((yield* send(one.config.authorizationHeader, session, "tools/list")).status).toBe(
          200,
        );
        expect(
          (yield* requestSession("DELETE", two.config.authorizationHeader, reconnectedSession))
            .status,
        ).toBe(204);
        expect((yield* send(two.config.authorizationHeader, undefined, "initialize")).status).toBe(
          200,
        );
        const oauth = yield* send("Bearer client-a", undefined, "initialize");
        const oauthSession = oauth.headers["mcp-session-id"]!;
        expect((yield* send("Bearer client-a", oauthSession, "tools/list")).status).toBe(200);
        expect((yield* send("Bearer client-b", oauthSession, "tools/list")).status).toBe(404);
        for (const method of ["GET", "DELETE"] as const)
          expect((yield* requestSession(method, "Bearer client-b", oauthSession)).status).toBe(404);
        expect((yield* requestSession("DELETE", "Bearer client-a", oauthSession)).status).toBe(204);
        expect((yield* send("Bearer client-a", oauthSession, "tools/list")).status).toBe(404);
        const disposable = yield* send(one.config.authorizationHeader, undefined, "initialize");
        const disposableId = disposable.headers["mcp-session-id"]!;
        expect(
          (yield* requestSession("DELETE", one.config.authorizationHeader, disposableId)).status,
        ).toBe(204);
        expect((yield* send(one.config.authorizationHeader, disposableId)).status).toBe(404);
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
        expect((yield* send("Bearer invalid-credential", session)).status).toBe(401);
        expect(seen).toEqual(["one", "one", "one"]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
);
