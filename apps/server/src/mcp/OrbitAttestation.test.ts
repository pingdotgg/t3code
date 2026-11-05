import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ORBIT_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { McpSchema } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Registry from "./McpSessionRegistry.ts";
import * as Broker from "./OrbitBroker.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

it.effect(
  "requires a trusted host attestation rather than an MCP response, and rechecks revocation",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("env");
      const threadId = ThreadId.make("parent");
      const scope: Invocation.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: "session",
        issuedAt: 1,
        client: undefined,
        capabilities: new Set(["orchestration"]),
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          orbitNeedsAttestation: true,
        },
      };
      const config = {
        environmentId,
        threadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: true,
        orbitNeedsAttestation: true,
      };
      const sessions = yield* Sessions.McpProviderSessions;
      yield* sessions.set(config);
      let response: "echo" | "parent" | "child" | "foreign" | "revoke" = "echo";
      let revoked = false;
      let forwarded = 0;
      const childScopes: boolean[] = [];
      const reverse: McpSchema.McpReverseClient = {
        listRoots: () => Effect.die("unused"),
        createMessage: () => Effect.die("unused"),
        elicit: (request) =>
          Effect.gen(function* () {
            if (response !== "echo")
              yield* sessions.attestHostInvocation(
                request.message.slice(ORBIT_HOST_CHALLENGE_PREFIX.length),
                response === "foreign" ? "foreign-session" : "session",
                response === "child",
              );
            if (response === "revoke") revoked = true;
            return { action: "accept" as const, content: { confirmed: true } };
          }),
      };
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: { elicitation: {} },
        clientInfo: { name: "test", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: { elicitation: {} },
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.succeed(reverse),
      });
      const layer = Broker.layer.pipe(
        Layer.provide(
          Layer.mock(Registry.McpSessionRegistry)({
            resolve: () => Effect.sync(() => (revoked ? undefined : scope)),
          }),
        ),
        Layer.provide(Layer.succeed(Sessions.McpProviderSessions, sessions)),
        Layer.provide(
          Layer.mock(Threads.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
        Layer.provide(
          Layer.mock(Environment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () =>
                Effect.succeed("separate-daemon-channel-credential-aaaaaaaaaaaa"),
              stat: () => Effect.succeed({ mode: 0o600 } as FileSystem.File.Info),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                forwarded++;
                if (request.body._tag === "Uint8Array") {
                  const body = JSON.parse(new TextDecoder().decode(request.body.body));
                  childScopes.push(body.identity.subagent);
                }
                return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
              }),
            ),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3CODE_ORBIT_BROKER_TOKEN_FILE: "/private/credential" },
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const broker = yield* Broker.OrbitBroker;
        const call = (operation: "orbit_context" | "ticket_update") =>
          broker
            .invoke({ operation, arguments: { ticket: "PLAN-1", note: "check" } })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        expect((yield* call("ticket_update").pipe(Effect.flip)).code).toBe("capability_denied");
        response = "foreign";
        expect((yield* call("ticket_update").pipe(Effect.flip)).code).toBe("capability_denied");
        expect(forwarded).toBe(0);
        response = "parent";
        expect(yield* call("ticket_update")).toEqual({ ok: true });
        response = "child";
        expect((yield* call("ticket_update").pipe(Effect.flip)).code).toBe("capability_denied");
        expect(yield* call("orbit_context")).toEqual({ ok: true });
        expect(forwarded).toBe(2);
        expect(childScopes).toEqual([false, true]);
        response = "revoke";
        expect((yield* call("ticket_update").pipe(Effect.flip)).code).toBe("capability_denied");
        expect(forwarded).toBe(2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Sessions.layer)),
);
