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
it.effect(
  "narrows an OAuth client's modes to the T3-Mode-Limit it sends, and never widens them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientToken = "client-payload.client-signature";
        const clientScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:linked",
          thread: undefined,
          client: { sessionId: "linked", label: "T3 Code · laptop", access: "auto" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        // Starts a thread at the modes the gate hands it, so the outcome is those modes.
        const StartsToolkit = Toolkit.make(
          Tool.make("starts", {
            description: "Reports the modes a started thread would run with.",
            parameters: Schema.Struct({
              runtimeMode: Schema.optional(RuntimeMode),
              interactionMode: Schema.optional(ProviderInteractionMode),
            }),
            success: Schema.Struct({ modes: Schema.String }),
            failure: OrchestratorMcpFailure,
            failureMode: "return",
            dependencies: [
              McpInvocationContext.McpInvocationContext,
              ThreadManagementService.ThreadManagementService,
            ],
          }),
        );
        const serverLayer = McpHttpServer.layerMcpTransport(
          McpHttpServer.toolkitRegistration(
            StartsToolkit,
            McpToolAccess.toLayer(StartsToolkit, {
              starts: McpToolAccess.startsThreads(
                (input) => input,
                (_, modes) =>
                  Effect.succeed({ modes: `${modes.runtimeMode}/${modes.interactionMode}` }),
                "stamped",
              ),
            }),
          ),
        ).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
              resolve: () => Effect.succeed(undefined),
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === `Bearer ${clientToken}`
                    ? clientScope
                    : undefined,
                ),
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const decodeOutcome = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              result: Schema.Struct({
                content: Schema.Array(Schema.Struct({ text: Schema.String })),
              }),
            }),
          ),
        );
        const decodeText = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Union([
              Schema.Struct({ modes: Schema.String }),
              Schema.Struct({ code: Schema.String }),
            ]),
          ),
        );
        /** Starts a thread as the client, with `limit` as T3-Mode-Limit; the HTTP status or the outcome. */
        const start = (limit: string | undefined, args: Record<string, string> = {}) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${clientToken}`,
              ...(limit === undefined ? {} : { "t3-mode-limit": limit }),
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            if (initialize.status !== 200) return initialize.status;
            const response = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "starts", arguments: args },
                }),
                "application/json",
              ),
            });
            const body = yield* decodeOutcome(yield* response.text);
            const outcome = yield* decodeText(
              body.result.content.map((part) => part.text).join(""),
            );
            return "code" in outcome ? outcome.code : outcome.modes;
          });

        // Approved for auto: without the header the client keeps its ceiling.
        expect(yield* start(undefined)).toBe("auto/default");
        // The header narrows both modes, and asking above it is refused.
        expect(yield* start("approval-required/plan")).toBe("approval-required/plan");
        expect(yield* start("approval-required/plan", { runtimeMode: "auto" })).toBe(
          "runtime_mode_escalation_denied",
        );
        expect(yield* start("auto-accept-edits/plan", { interactionMode: "default" })).toBe(
          "interaction_mode_escalation_denied",
        );
        // A broader header changes nothing: the approved ceiling still holds.
        expect(yield* start("full-access/default")).toBe("auto/default");
        expect(yield* start("full-access/default", { runtimeMode: "full-access" })).toBe(
          "runtime_mode_escalation_denied",
        );
        // A malformed header is refused before anything runs.
        expect(yield* start("auto")).toBe(400);
        expect(yield* start("auto/default/extra")).toBe(400);
        expect(yield* start("root/default")).toBe(400);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
