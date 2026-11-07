import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/http";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as Broker from "./ExternalToolBroker.ts";
import { ExternalToolToolkit } from "./toolkits/external-tools/tools.ts";
import * as ExternalToolHandlers from "./toolkits/external-tools/handlers.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const env = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
  getDescriptor: Effect.die("unused"),
});

it.effect(
  "verifies host attestation over HTTP while denying echoed acceptance and native children",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Registry.__testing
          .make({})
          .pipe(Effect.provideService(ServerEnvironment.ServerEnvironment, env));
        const sessions = yield* Sessions.McpProviderSessions;
        const issued = yield* registry.issue({
          threadId: ThreadId.make("root"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          externalToolAttestationEnabled: true,
        });
        const cfg = issued.config;
        yield* sessions.set(cfg);
        let forwarded = 0;
        const broker = Broker.layer.pipe(
          Layer.provide(Layer.succeed(Registry.McpSessionRegistry, registry)),
          Layer.provide(Layer.succeed(Sessions.McpProviderSessions, sessions)),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            }),
          ),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, env)),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  forwarded++;
                  return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
                }),
              ),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_EXTERNAL_TOOL_TARGETS: JSON.stringify({
                    sample: { endpoint: "http://localhost/tool", operations: ["write"] },
                  }),
                },
              }),
            ),
          ),
        );
        yield* HttpRouter.serve(
          McpHttpServer.layerMcpTransport(
            McpHttpServer.toolkitRegistration(ExternalToolToolkit, ExternalToolHandlers.layer).pipe(
              Layer.provide(broker),
              Layer.provide(
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
                }),
              ),
            ),
          ).pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(Layer.succeed(Registry.McpSessionRegistry, registry)),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);
        const http = yield* HttpClient.HttpClient;
        const post = (session: string | undefined, body: unknown) =>
          http.post("/mcp", {
            headers: {
              authorization: cfg.authorizationHeader,
              accept: "application/json, text/event-stream",
              ...(session === undefined
                ? {}
                : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
            },
            body: HttpBody.text(JSON.stringify(body), "application/json"),
          });
        const init = yield* post(undefined, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
            clientInfo: { name: "probe", version: "1" },
          },
        });
        const session = init.headers["mcp-session-id"]!;
        yield* post(session, { jsonrpc: "2.0", method: "notifications/initialized" });
        const log: string[] = [];
        const run = (mode: "attest" | "echo" | "child") =>
          Effect.gen(function* () {
            const res = yield* post(session, {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "external_tool",
                arguments: { target: "sample", operation: "write" },
              },
            });
            log.push(`tools/call status=${res.status} ct=${res.headers["content-type"]}`);
            let buffer = "";
            let final: unknown;
            yield* res.stream.pipe(
              Stream.decodeText(),
              Stream.runForEachWhile((chunk) =>
                Effect.gen(function* () {
                  buffer += chunk;
                  const lines = buffer.split("\n");
                  buffer = lines.pop() ?? "";
                  for (const line of lines) {
                    const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
                    if (!t.startsWith("{")) continue;
                    const msg = JSON.parse(t);
                    log.push(
                      `frame ${String(msg.method ?? "result")} ${JSON.stringify(msg.params?.mode ?? "")} ${String(msg.params?.message ?? "").slice(0, 40)}`,
                    );
                    if (msg.method === "elicitation/create") {
                      const id = msg.params.message.slice(
                        EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX.length,
                      );
                      if (mode !== "echo")
                        yield* sessions.attestHostInvocation(
                          id,
                          cfg.providerSessionId,
                          mode === "child",
                        );
                      const r = yield* post(session, {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: { action: "accept", content: { confirmed: true } },
                      });
                      log.push(`elicit reply status=${r.status}`);
                    } else if (msg.id === 2) {
                      final = msg.result ?? msg.error;
                      return false;
                    }
                  }
                  return true;
                }),
              ),
              Effect.timeout("15 seconds"),
            );
            return final;
          });
        const a = yield* run("attest");
        const b = yield* run("echo");
        const c = yield* run("child");
        const stillOk = yield* run("attest");
        const del = yield* http.execute(
          HttpClientRequest.make("DELETE")("/mcp").pipe(
            HttpClientRequest.setHeaders({
              authorization: cfg.authorizationHeader,
              "mcp-session-id": session,
              "mcp-protocol-version": "2025-06-18",
            }),
          ),
        );
        const afterDel = (yield* post(session, { jsonrpc: "2.0", id: 9, method: "tools/list" }))
          .status;
        expect(del.status).toBe(204);
        expect(afterDel).toBe(404);
        expect(JSON.stringify(a)).toContain('"ok":true');
        expect(JSON.stringify(b)).toContain('"isError":true');
        expect(JSON.stringify(c)).toContain('"isError":true');
        expect(JSON.stringify(stillOk)).toContain('"ok":true');
        expect(forwarded).toBe(2);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Sessions.layer,
          NodeHttpServer.layerTest,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
);
