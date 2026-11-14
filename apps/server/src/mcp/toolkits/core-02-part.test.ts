import * as DocumentText from "../../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskError,
  ScheduledTask,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { dispatchFailure } from "../threadAccess.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";

import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";




















import { layerOrchestratorToolkit, declaredFailure, decodeMcpAttachmentInput, decodeThreadReadResult, layerThreadToolkit, threadId, scope, client, clientScope, scheduledTask } from "./core-fixtures.testkit.ts";
it.effect.each([
  {
    scenario: "explains why a webhook task cannot run manually",
    tasks: [
      {
        ...Schema.decodeSync(ScheduledTask)(scheduledTask("task-webhook", "full-access")),
        schedule: { type: "webhook" as const, signature: null },
      },
    ],
    error: new ScheduledTaskError({
      message: "Webhook tasks run when their URL receives a request.",
      cause: new Error("private-webhook-cause"),
    }),
    code: "orchestration_error",
    message: "Webhook tasks run when their URL receives a request.",
  },
  {
    scenario: "reports a missing task before trying to run it",
    tasks: [],
    error: new ScheduledTaskError({ message: "must not run a missing task" }),
    code: "invalid_request",
    message: "The scheduled task was not found.",
  },
])("run_scheduled_task_now $scenario", ({ tasks, error, code, message }) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "run_scheduled_task_now", arguments: { taskId: "task-webhook" } })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(declaredFailure(result)).toEqual({ _tag: "OrchestratorMcpFailure", code, message });
    expect(JSON.stringify(result)).not.toContain("private-");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () => Effect.succeed({ tasks }),
            runNow: () => Effect.fail(error),
          }),
        ),
      ),
    ),
  ),
);
it.effect.each(["t3_thread_interrupt", "t3_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "t3_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        ),
      ),
    ),
);
it.effect("discovers workflow stop targets and requires orchestration capability", () => {
  const threadId = ThreadId.make("workflow-parent");
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const subagentId = NodeId.make("workflow-coordinator");
  const itemId = TurnItemId.make("workflow-coordinator-activity");
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: shell.activeRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: "Workflow: checkout review",
      startedAt: shell.createdAt,
      completedAt: null,
      updatedAt: shell.updatedAt,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make("workflow-child"),
      prompt: "Review checkout",
      result: null,
    },
  };
  const stopped: Array<{ readonly threadId: ThreadId; readonly subagentId: string }> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = clientScope("full-access");
    const read = yield* server
      .callTool({ name: "t3_thread_read", arguments: { threadId, view: "activity" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(read.isError).toBe(false);
    const result = yield* decodeThreadReadResult(read.structuredContent);
    expect(result.items[0]?.subagentId).toBe(subagentId);
    const call = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name: "t3_workflow_stop",
          arguments: { threadId, subagentId: result.items[0]?.subagentId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const denied = yield* call({ ...scope, capabilities: new Set(["worktree"]) });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(stopped).toEqual([]);
    const allowed = yield* call(scope);
    expect(allowed.isError).toBe(false);
    expect(stopped).toEqual([{ threadId: "workflow-parent", subagentId: "workflow-coordinator" }]);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getTimelinePage: () => Effect.succeed({ items: [row], totalItems: 1, hasMore: false }),
            stopWorkflow: (input) =>
              Effect.sync(() => {
                stopped.push(input);
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  );
});
it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("t3_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    const discarded = yield* call(
      "t3_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provide(
          DocumentText.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);
it.effect(
  "t3_thread_list settled:false with an empty statuses list lists the unsettled threads",
  () => {
    const unsettled = McpToolAccessTestkit.liveThreadShell(ThreadId.make("unsettled-thread"));
    const settled = {
      ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("settled-thread")),
      settledOverride: "settled",
    } as const;
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "t3_thread_list",
          arguments: { projectId: unsettled.projectId, settled: false, statuses: [] },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("full-access"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        threads: [{ threadId: unsettled.id, settled: false }],
        total: 1,
      });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              listProjectThreads: () => Effect.succeed([unsettled, settled]),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        ),
      ),
    );
  },
);
