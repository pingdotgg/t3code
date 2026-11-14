import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceId,
  DeviceOperationError,
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PreviewTabId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

import * as DeviceService from "../device/DeviceService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
















// regression: #10501 keep preview snapshots usable by the agent

// regression: #13558 preview snapshots overflowed the agent's tool output






import { environmentId, threadId, alternateTabId, decodeJsonText, invocation, client, layerTest, layerPullRequestsTest, snapshotResult, layerRecordingTools } from "./McpHttpServer-fixtures.testkit.ts";
it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport(Layer.empty).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          ProbeToolkit,
          McpToolAccess.toLayer(ProbeToolkit, {
            probe: McpToolAccess.reads(() =>
              McpInvocationContext.McpInvocationContext.pipe(
                Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
                Effect.as({ ok: true }),
              ),
            ),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
it.effect("accepts case-insensitive MCP bearer schemes and diagnoses rejected credentials", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-auth-header-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
      const oauth = yield* auth.issueMcpClientSession({
        label: "MCP header test",
        access: "read-only",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(Layer.empty).pipe(
          Layer.provide(McpOAuth.layerMcpClientAuthenticator),
          Layer.provide(ServerSettings.layerTest()),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initialize = (authorization?: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-header-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });

      for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
        for (const [kind, token] of [
          ["provider", providerToken],
          ["OAuth", oauth.token],
        ]) {
          const response = yield* initialize(`${scheme} ${token}`);
          expect.soft(response.status, `${kind} ${scheme}`).toBe(200);
        }
      }
      messages.length = 0;
      for (const [authorization, reason] of [
        [undefined, "missing_authorization_header"],
        [`Basic ${providerToken}`, "unsupported_scheme"],
        ["Bearer", "missing_bearer_token"],
        ["bEaReR ", "missing_bearer_token"],
        [`bearer ${providerToken.toUpperCase()}`, "unknown_or_expired_token"],
        [`bEaReR ${oauth.token.toUpperCase()}`, "unknown_or_expired_token"],
      ] as const) {
        const response = yield* initialize(authorization);
        expect(response.status).toBe(401);
        expect
          .soft(messages.at(-1))
          .toEqual(["rejected MCP request with an unusable credential", { reason }]);
        const body = yield* response.text;
        expect(body).not.toContain(providerToken);
        expect(body).not.toContain(oauth.token);
        expect(JSON.stringify(response.headers)).not.toContain(providerToken);
        expect(JSON.stringify(response.headers)).not.toContain(oauth.token);
      }
      yield* registry.revokeThread(threadId);
      yield* auth.revokeSession(oauth.sessionId);
      for (const token of [providerToken, oauth.token]) {
        expect((yield* initialize(`bearer ${token}`)).status).toBe(401);
      }
      expect(JSON.stringify(messages)).not.toContain(providerToken);
      expect(JSON.stringify(messages)).not.toContain(oauth.token);
      expect(JSON.stringify(messages)).not.toContain(providerToken.toUpperCase());
      expect(JSON.stringify(messages)).not.toContain(oauth.token.toUpperCase());
    }),
  ).pipe(
    Effect.provide(
      layerAuth.pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ),
  );
});
it.effect("hides tools for links and refuses another environment while the beta is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "linksToken";
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make("thread-links"),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const LinksToolkit = Toolkit.make(
        Tool.make("links", {
          description: "Lists links.",
          success: Schema.Struct({ links: Schema.Number }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileLinksOff),
        Tool.make("where", {
          description: "Says where it ran.",
          parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
          success: Schema.Struct({ ranIn: Schema.String }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
      );
      const settingsContext = yield* Layer.build(ServerSettings.layerTest());
      const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          LinksToolkit,
          McpToolAccess.toLayer(LinksToolkit, {
            links: McpToolAccess.reads(() => Effect.succeed({ links: 0 })),
            where: McpToolAccess.reads(() => Effect.succeed({ ranIn: "here" })),
          }),
        ),
      ).pipe(
        Layer.provide(Layer.succeedContext(settingsContext)),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const rpc = (method: string, params: object) =>
        httpClient
          .post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((response) => response.json));
      const listed = () =>
        rpc("tools/list", {}).pipe(
          Effect.map((body) =>
            (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
              (tool) => tool.name,
            ),
          ),
        );
      const ranIn = (where: EnvironmentId) =>
        rpc("tools/call", { name: "where", arguments: { environmentId: where } }).pipe(
          Effect.map(
            (body) =>
              (
                body as {
                  result: {
                    isError?: boolean;
                    structuredContent?: unknown;
                    content: ReadonlyArray<{ text: string }>;
                  };
                }
              ).result,
          ),
        );
      const elsewhere = EnvironmentId.make("environment-elsewhere");

      expect(yield* listed()).toEqual(["where"]);
      expect(yield* ranIn(elsewhere)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("Linked environments is off on this machine") }],
      });
      expect((yield* ranIn(environmentId)).structuredContent).toEqual({ ranIn: "here" });

      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      expect(yield* listed()).toEqual(["links", "where"]);
      // On, the call goes on to the forwarding, which this server lacks.
      expect(yield* ranIn(elsewhere)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("cannot reach linked environments") }],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
it.effect("lists pull request watch tools only to threads that are not delegated children", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeFor = (
        token: string,
        subagent: boolean,
      ): McpInvocationContext.McpThreadInvocationScope => ({
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make(`thread-${token}`),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
          subagent,
        },
        client: undefined,
        capabilities: new Set(["pull-requests"]),
        issuedAt: 1,
      });
      const scopes = new Map([
        ["parentToken", scopeFor("parentToken", false)],
        ["childToken", scopeFor("childToken", true)],
      ]);
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.layerPullRequestsToolkit,
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(scopes.get(token)),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            McpToolAccessTestkit.liveThreadsLayer,
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const listedTools = (token: string) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const listed = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const body = (yield* listed.json) as {
            readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
          };
          return body.result.tools.map((tool) => tool.name);
        });

      const parentTools = yield* listedTools("parentToken");
      const childTools = yield* listedTools("childToken");
      expect(parentTools).toEqual(
        expect.arrayContaining(["link_pull_request", "watch_pull_request", "unwatch_pull_request"]),
      );
      expect(childTools).toContain("link_pull_request");
      expect(childTools).not.toContain("watch_pull_request");
      expect(childTools).not.toContain("unwatch_pull_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
