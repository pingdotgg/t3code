import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-fork-interrupt-keeps-results-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("runs here never reach a provider"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

// ProviderContinuationService turns a reserved delivery into the queued wake, as in production.
const layerContinuationWorkerTest = ProviderContinuationService.layer.pipe(
  Layer.provide(Layer.merge(ProviderContinuationRequests.layer, IdAllocator.layer)),
  Layer.provideMerge(layerTest),
);

it.layer(layerContinuationWorkerTest)(
  "interrupting a run whose finished results wait in a queued wake",
  (it) => {
    it.effect(
      "keeps that wake, which starts after the interrupt, and disposes a running task",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const projects = yield* ProjectService.ProjectService;
          const projectId = ProjectId.make("project:interrupt-keeps-results");
          const threadId = ThreadId.make("thread:interrupt-keeps-results");
          yield* projects.create({
            commandId: CommandId.make("create-project:interrupt-keeps-results"),
            projectId,
            title: "Interrupt keeps results",
            workspaceRoot: "/workspace/interrupt-keeps-results",
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("create-thread:interrupt-keeps-results"),
            threadId,
            projectId,
            title: "Lead",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("send:interrupt-keeps-results"),
            threadId,
            messageId: MessageId.make("message:interrupt-keeps-results:lead"),
            text: "Delegate the work and keep going",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const lead = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("delegate:interrupt-keeps-results"),
            parentThreadId: threadId,
            parentRunId: lead.id,
            parentNodeId: lead.rootNodeId!,
            task: "Write the report",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
          });
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("delegate:interrupt-keeps-results:running"),
            parentThreadId: threadId,
            parentRunId: lead.id,
            parentNodeId: lead.rootNodeId!,
            task: "Keep researching",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
          });
          const delegated = (yield* orchestrator.getThreadProjection(threadId)).subagents;
          const task = delegated.find((candidate) => candidate.prompt === "Write the report")!;
          const running = delegated.find((candidate) => candidate.prompt === "Keep researching")!;
          const childRun = (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!;
          const now = yield* DateTime.now;
          const beforeResult = yield* sink.latestSequence();
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:${childRun.id}:completed`),
                type: "run.updated",
                threadId: task.childThreadId!,
                runId: childRun.id,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: { ...childRun, status: "completed", completedAt: now },
              },
            ],
          });
          const resultReserved = yield* sink
            .stream({ afterSequence: beforeResult, eventType: "message.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "message.updated" &&
                  stored.event.payload.delegatedCompletion?.taskIds.includes(task.id) === true,
              ),
              Stream.take(1),
              Stream.runHead,
            );
          const wakeMessageId =
            resultReserved._tag === "Some" && resultReserved.value.event.type === "message.updated"
              ? resultReserved.value.event.payload.id
              : undefined;
          const queued = yield* orchestrator.getThreadProjection(threadId);
          const wake = queued.runs.find((run) => run.userMessageId === wakeMessageId);
          assert.equal(
            wake?.status,
            "queued",
            "the finished result waits in a wake behind the lead",
          );
          assert.equal(
            queued.subagents.find((candidate) => candidate.id === task.id)?.completionDelivery
              ?.state,
            "claimed",
          );

          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("interrupt:interrupt-keeps-results"),
            threadId,
            runId: lead.id,
            reason: "Stopped by an agent: run open too long",
          });
          yield* orchestrator.resumeQueuedRuns;

          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(after.runs.find((run) => run.id === lead.id)?.status, "interrupted");
          assert.equal(
            after.subagents.find((candidate) => candidate.id === task.id)?.completionDelivery
              ?.state,
            "claimed",
            "the finished result still belongs to the kept wake",
          );
          assert.equal(
            after.subagents.find((candidate) => candidate.id === running.id)?.completionDelivery
              ?.state,
            "disposed",
            "a task still running at the interrupt no longer wakes the lead",
          );
          assert.equal(
            after.runs.find((run) => run.id === wake!.id)?.status,
            "starting",
            "the wake that carries the result starts once the interrupted run ends",
          );
        }),
    );
  },
);
