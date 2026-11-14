import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  DeviceToolError,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  ProviderInteractionMode,
  type RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  MAX_REPORTED_DEPTH,
  toolOutcome,
} from "../telemetry/ProviderDimensions.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlPreviewTool, HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { requestUrl } from "../requestUrl.ts";
import { HANDOFF_TOOLS, RESULT_TARGET_ACTIONS, handoffTargetIds, hasAction, isInputTargetHandoff } from "./McpHttpServer.ts";

export const withToolAnalytics =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* <A, E, R>(registration: Effect.Effect<A, E, R>) {
    const server = yield* McpServer.McpServer;
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    if (Option.isNone(analytics)) return yield* registration;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    const shellOf = (threadId: string) =>
      Option.isNone(threads)
        ? Effect.succeed(null)
        : threads.value
            .getThreadShell(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => null));
    // Delegation depth: parents walked from the caller, capped.
    const depthOf =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (thread: AgentThread) {
        let depth = 0;
        let parentId =
          thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
        while (parentId !== null && depth < MAX_REPORTED_DEPTH) {
          depth += 1;
          const parent = yield* shellOf(parentId);
          parentId =
            parent?.lineage.relationshipToParent === "subagent"
              ? parent.lineage.parentThreadId
              : null;
        }
        return depth;
      });
    // Whether the caller's active run was started by a scheduled task.
    const scheduledRunOf = (threadId: string, runId: RunId | null) =>
      Option.isNone(threads) || runId === null
        ? Effect.succeed(false)
        : threads.value
            .getThreadRecords(ThreadId.make(threadId), ["runs", "messages"], {
              runIds: [runId],
              messageRoles: ["user"],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((candidate) => candidate.id === runId);
                return records.messages.some(
                  (message) =>
                    message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
                );
              }),
              Effect.orElseSucceed(() => false),
            );
    const record =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (
          tool: string,
          args: unknown,
          result: McpSchema.CallToolResult | undefined,
          durationMs: number,
        ) {
          const handoff =
            HANDOFF_TOOLS.has(tool) ||
            isInputTargetHandoff(tool, args) ||
            hasAction(RESULT_TARGET_ACTIONS, tool, args);
          const outcome = toolOutcome(result);
          // Agents call status, read, and preview tools in tight loops, so an
          // event per successful call floods analytics. Only failures count there.
          if (!handoff && outcome.outcome === "ok") return;
          // Client credentials (no calling thread) report an unknown caller.
          const invocation = Option.getOrUndefined(
            yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
          )?.thread;
          const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
          // Only handoff tools pay for thread lookups; the rest report the
          // caller's provider from the credential.
          const caller =
            handoff && invocation !== undefined
              ? ((yield* shellOf(invocation.threadId)) ?? undefined)
              : undefined;
          const targetIds = handoff
            ? [...new Set(handoffTargetIds(tool, args, result))].filter(
                (threadId) => threadId !== invocation?.threadId,
              )
            : [];
          const targets = yield* Effect.forEach(targetIds, shellOf);
          for (const properties of agentToolProperties({
            tool,
            providers,
            caller,
            ...(invocation === undefined
              ? {}
              : { callerProviderInstanceId: invocation.providerInstanceId }),
            ...(caller === undefined || invocation === undefined
              ? {}
              : {
                  callerDepth: yield* depthOf(caller),
                  callerScheduledRun: yield* scheduledRunOf(
                    invocation.threadId,
                    caller.activeRunId,
                  ),
                }),
            targets: targets.filter((thread) => thread !== null),
            outcome,
            ...(handoff
              ? { settings: handoffSettings(tool, args, result?.structuredContent) }
              : {}),
            durationMs,
          })) {
            yield* analytics.value.record("mcp.tool.invoked", properties);
          }
        },
        (effect, _tool, _args, _result, _durationMs) => effect.pipe(Effect.ignoreCause),
      );
    const recordingServer = McpServer.McpServer.of({
      ...server,
      addTool: Effect.fn("McpServer.addTool")(function (options) {
        return server.addTool({
          ...options,
          handle:
            /* Request instrumentation already owns the span; keep this helper in that context. */
            Effect.fnUntraced(function* (payload) {
              const startedAt = yield* Clock.currentTimeMillis;
              return yield* options.handle(payload).pipe(
                Effect.onExit((exit) => {
                  const result = exit._tag === "Success" ? exit.value : undefined;
                  // A call that asks for input is retried with it, and that call is the one counted.
                  if (result instanceof McpSchema.InputRequired) return Effect.void;
                  // Handoff tools look up threads to record; the response must not wait on them.
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((endedAt) =>
                      record(options.tool.name, payload, result, endedAt - startedAt),
                    ),
                    Effect.forkDetach,
                    Effect.asVoid,
                  );
                }),
              );
            }),
        });
      }),
    });
    return yield* registration.pipe(Effect.provideService(McpServer.McpServer, recordingServer));
  });

/** `McpServer.registerToolkit` advertises the full codec schema; agents get the compact one. */
