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

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const launched = liveThreadShell(ThreadId.make(`mcp:${bareId}`));
  const deletedLaunched = { ...launched, deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") };
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    sent: Ref.Ref<number>,
    overrides: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  ) =>
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            ...overrides,
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
        ),
      ),
    );
  const failuresFor = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const read = yield* mcp.readThread(client, { threadId: bareId }).pipe(Effect.flip);
        const send = yield* mcp
          .sendToThread(client, { threadId: bareId, message: "hello" })
          .pipe(Effect.flip);
        const wait = yield* mcp.waitForThread(client, { threadId: bareId }).pipe(Effect.flip);
        return { read, send, wait, sends: yield* Ref.get(sent) };
      }).pipe(Effect.provide(service(shells, sent)));
    });

  it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const { read, send, wait, sends } = yield* failuresFor([launched]);
      for (const error of [read, send, wait]) {
        assert.equal(error.code, "thread_not_found");
        assert.include(error.message, `mcp:${bareId}`);
      }
      assert.equal(sends, 0);
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.code, "thread_not_found");
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("refuses waiting without orchestration capability before reading the target", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* mcp
          .waitForThread({ ...client, capabilities: new Set() }, { threadId: bareId })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unauthorized target access"),
          }),
        ),
      );
    }),
  );

  it.effect("waits on the caller's own thread without a separate shell lookup", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* mcp.waitForThread(
          {
            ...client,
            thread: {
              threadId: launched.id,
              providerSessionId: "provider-session:wait-self",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          { threadId: launched.id },
        );
        assert.deepEqual(result, {
          threadId: launched.id,
          runId: null,
          status: "idle",
          timedOut: false,
        });
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unexpected shell lookup for the caller"),
            getThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            waitForThread: () =>
              Effect.succeed({ threadId: launched.id, run: null, timedOut: false }),
          }),
        ),
      );
    }),
  );
});

describe("OrchestratorMcpService thread list", () => {
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-list"),
    requestNamespace: "client:thread-list",
    thread: undefined,
    client: { sessionId: "thread-list", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const shell = (id: string, projectId: string, snoozed: boolean) => ({
    ...liveThreadShell(ThreadId.make(id)),
    projectId: ProjectId.make(projectId),
    status: "completed" as const,
    snoozedUntil: snoozed ? DateTime.makeUnsafe("2099-01-01T00:00:00Z") : null,
  });
  const shells = [
    shell("thread:a-snoozed", "project:a", true),
    shell("thread:a-awake", "project:a", false),
    shell("thread:b-snoozed", "project:b", true),
  ];
  const service = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.succeed(
              shells.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
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
      ),
    ),
  );

  it.effect("lists snoozed threads across every project with allProjects", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        allProjects: true,
        projectId: ProjectId.make("project:a"),
        snoozed: true,
      });
      assert.equal(listed.projectId, null);
      assert.deepStrictEqual(
        listed.threads.map((thread) => [thread.threadId, thread.projectId]),
        [
          ["thread:a-snoozed", "project:a"],
          ["thread:b-snoozed", "project:b"],
        ],
      );
    }).pipe(Effect.provide(service)),
  );
});

describe("OrchestratorMcpService thread stop", () => {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "gpt-5.4" };
  const threadId = ThreadId.make("thread:mcp-stop");
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-stop"),
    requestNamespace: "client:mcp-stop",
    thread: undefined,
    client: { sessionId: "mcp-stop", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  // A provider whose turns run until they are interrupted.
  const liveAdapter = (cwd: string): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId: appThreadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${appThreadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${appThreadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: null,
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            }).pipe(Effect.asVoid),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  });

  it.effect.each([
    { name: "a running turn", queued: false },
    { name: "a running turn with a queued message", queued: true },
  ])("t3_thread_interrupt stop reports the run it interrupted on $name", ({ queued }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("mcp-thread-stop");
        const layerAdapters = ProviderAdapterRegistry.layerSingle(liveAdapter(cwd));
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-thread-stop" },
          layerAdapters,
          { databaseLayer: layerDatabase, runEffectWorker: false },
        );
        const layerThreads = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
        );
        const layerTest = layerOrchestratorService.pipe(
          Layer.provideMerge(layerThreads),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              layerAdapters,
              ServerSettings.layerTest(),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const send = (text: string, type: "start_immediately" | "queue_after_active") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${text}`),
              threadId,
              messageId: MessageId.make(`message:${text}`),
              text,
              attachments: [],
              dispatchMode: { type },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:mcp-stop"),
            title: "Stop",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* send("work", "start_immediately");
          yield* worker.drain();
          yield* Fiber.join(running);
          if (queued) yield* send("later", "queue_after_active");
          const before = yield* orchestrator.getThreadProjection(threadId);
          const runningRun = before.runs.find((run) => run.status === "running")!;
          assert.equal(before.runs.filter((run) => run.status === "queued").length, queued ? 1 : 0);

          const stopped = yield* service.interruptThread(client, {
            threadId,
            stop: true,
            clientRequestId: "stop",
          });
          assert.deepEqual(stopped, {
            threadId,
            runId: runningRun.id,
            status: "interrupt_requested",
          });
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
