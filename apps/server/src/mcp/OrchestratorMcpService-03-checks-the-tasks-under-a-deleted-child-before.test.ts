import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpTarget,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  decodeTarget,
  layerOrchestratorService,
} from "./OrchestratorMcpService-fixtures.testkit.ts";

describe("OrchestratorMcpService", () => {
  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const subagentReads = yield* Ref.make<ReadonlyArray<ProjectionRecordFilter | undefined>>([]);
      const appOwnedTask = (
        id: string,
        threadId: ThreadId,
        childId: ThreadId,
        settled?: "settled",
      ) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        status: settled === undefined ? "running" : "completed",
        result: settled === undefined ? null : "Done.",
        completionDelivery: { state: settled === undefined ? "pending" : "delivered" },
      });
      // Older tasks the parent and child dispatched and that have long settled.
      const settledThreadId = ThreadId.make("thread:mcp-cancel-grandchild-settled");
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-old",
                parentThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask(taskId, parentThreadId, childThreadId),
            ],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId, title: "Child" },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-done",
                childThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          settledThreadId,
          {
            thread: { id: settledThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) =>
            ((fields as ReadonlyArray<string>).includes("subagents")
              ? Ref.update(subagentReads, (reads) => [...reads, filter])
              : Effect.void
            ).pipe(Effect.as(projections.get(threadId)!)),
          listAppOwnedChildThreadIds: (threadId) =>
            Effect.succeed(
              projections
                .get(threadId)!
                .subagents.flatMap((task) =>
                  task.origin === "app_owned" && task.childThreadId !== null
                    ? [task.childThreadId]
                    : [],
                ),
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        // No read decodes every task a thread has dispatched.
        for (const filter of yield* Ref.get(subagentReads)) {
          assert.isTrue(
            filter?.subagentIds !== undefined || filter?.omitSettledSubagents !== undefined,
          );
        }
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});
