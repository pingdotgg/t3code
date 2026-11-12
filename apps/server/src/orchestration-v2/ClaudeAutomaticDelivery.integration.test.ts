import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const sessionId = "automatic-delivery-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const decodeScheduledTask = Schema.decodeEffect(ScheduledTaskUpsertInput);
const refusal =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const statusIds = ["status-1", "status-2", "status-3", "status-4"];
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const batch = frame({
  type: "assistant",
  uuid: "batch",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    id: "tool-batch",
    role: "assistant",
    type: "message",
    model: modelSelection.model,
    content: [
      { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
      ...statusIds.map((id) => ({
        type: "tool_use",
        id,
        name: "mcp__t3-code__task_status",
        input: { taskId: id },
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

const toolResult = (id: string, cancelled: boolean) =>
  frame({
    type: "user",
    uuid: `result-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: cancelled,
          content: cancelled ? refusal : id === "build" ? "build OK" : "Task completed normally",
        },
      ],
    },
    ...(cancelled ? { tool_result_meta: [{ id, non_execution_kind: "cancelled" }] } : {}),
  });

const result = (uuid: string, aborted: boolean) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: aborted ? "aborted_tools" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const deliveries = [
  "child completion",
  "scheduled message",
  "user steering",
  "promoted queued message",
] as const;

it.effect.each(deliveries)(
  "delivers %s with Claude's native pending-tool cancellation behavior",
  (delivery) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-automatic-delivery");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offers: SDKUserMessage[] = [];
      const nativeQueue: SDKUserMessage[] = [];
      // @effect-diagnostics-next-line abortControllerInEffect:off - The fake SDK interrupts its batch independently of the test fiber.
      const batchAbort = new AbortController();
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages),
              offer: (message) =>
                Effect.sync(() => {
                  offers.push(message);
                  nativeQueue.push(message);
                  // Claude Code 2.1.289 aborts on now-priority commands even while Bash blocks reads.
                  if (nativeQueue.some((command) => command.priority === "now")) {
                    batchAbort.abort({ kind: "interrupt" });
                  }
                }),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              getContextUsage: Effect.fail(
                new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                  method: "getContextUsage",
                  cause: new Error("Unsupported control request subtype"),
                }),
              ),
              stopTask: () => Effect.void,
              interrupt: Effect.die("automatic delivery must never interrupt"),
              close: Effect.void,
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:automatic-delivery");
        const projectId = ProjectId.make("project:automatic-delivery");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Automatic delivery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Build and check all four tasks.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const pending = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.nativeItemRef?.nativeId === "status-4",
        );
        yield* Queue.offer(sdkMessages, batch);
        yield* Fiber.join(pending);
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.turnItems.filter((item) => item.status === "running").length, 5);
        const parent = before.runs[0]!;
        if (parent.rootNodeId === null) return yield* Effect.die("parent has no root node");
        const messageId = MessageId.make("automatic-notice");
        if (delivery === "child completion") {
          const taskId = NodeId.make("completed-child");
          const now = yield* DateTime.now;
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("cohort"),
                type: "run.updated",
                threadId,
                runId: parent.id,
                occurredAt: now,
                payload: {
                  ...parent,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId, taskIds: [taskId] },
                  },
                },
              },
              {
                id: EventId.make("child"),
                type: "subagent.updated",
                threadId,
                runId: parent.id,
                nodeId: taskId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: parent.id,
                  parentNodeId: parent.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  providerInstanceId: modelSelection.instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Background work",
                  title: "Child",
                  model: null,
                  completionWake: "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          const command = {
            type: "message.dispatch" as const,
            commandId: CommandId.make("completion"),
            threadId,
            messageId,
            text: "Child completed",
            attachments: [],
            dispatchMode: { type: "queue_after_active" as const },
            createdBy: "agent" as const,
            creationSource: "server" as const,
            delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
          };
          yield* orchestrator.dispatch(command);
          yield* orchestrator.dispatch(command);
          yield* orchestrator.recoverDelegatedTasks;
        } else if (delivery === "scheduled message") {
          yield* Effect.gen(function* () {
            const service = yield* ScheduledTaskService.ScheduledTaskService;
            const { task } = yield* service.upsert(
              yield* decodeScheduledTask({
                title: "Status check",
                prompt: "Check the four tasks.",
                enabled: true,
                schedule: { type: "interval", everyMs: 60_000 },
                projectId,
                threadId,
                workspaceStrategy: { type: "root" },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
              }),
            );
            const ran = yield* service.runNow({ id: task.id });
            assert.equal(ran.task.lastRunStatus, "succeeded");
          }).pipe(
            Effect.provide(
              ScheduledTaskService.layer.pipe(
                Layer.provide(ThreadManagementService.layer),
                Layer.provide(ServerSettings.layerTest()),
                Layer.provide(
                  Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
                    ensureTranscript: () =>
                      Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
                  }),
                ),
                Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
                Layer.provide(ManagedPolicy.layerTest()),
                Layer.provide(
                  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                    namedProjectsRoot: "/projects",
                    isScratchProject: () => Effect.succeed(false),
                  }),
                ),
                Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
                Layer.provide(
                  CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                ),
                Layer.provide(
                  Layer.mergeAll(NodeCrypto.layer, Scheduler.layer, SqlitePersistence.layerMemory),
                ),
              ),
            ),
          );
        } else if (delivery === "user steering") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId,
            text: "Change direction now.",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: parent.id },
            createdBy: "user",
            creationSource: "web",
          });
        } else {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue"),
            threadId,
            messageId,
            text: "Change direction now.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: parent.id,
          });
          const promoted = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(promoted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
          assert.equal(
            promoted.messages.find((message) => message.id === messageId)?.runId,
            parent.id,
          );
          const steer = promoted.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          );
          assert.ok(steer?.type === "user_message");
          assert.equal(steer.inputIntent, "promoted_queued_to_steer");
        }
        yield* worker.drain();
        const explicitSteer =
          delivery === "user steering" || delivery === "promoted queued message";
        assert.equal(batchAbort.signal.aborted, explicitSteer);
        assert.equal(offers.length, explicitSteer ? 2 : 1);
        const finished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parent.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, toolResult("build", false));
        for (const id of statusIds)
          yield* Queue.offer(sdkMessages, toolResult(id, batchAbort.signal.aborted));
        if (explicitSteer) yield* Queue.offer(sdkMessages, result("aborted", true));
        yield* Queue.offer(sdkMessages, result("completed", false));
        yield* Fiber.join(finished);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (!explicitSteer) {
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
          const noticeFinished = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status === "waiting",
          );
          const delivered =
            delivery === "child completion"
              ? yield* watch(
                  (event) =>
                    event.type === "subagent.updated" &&
                    event.payload.completionDelivery?.state === "delivered",
                )
              : null;
          yield* Queue.offer(sdkMessages, result("notice-completed", false));
          yield* Fiber.join(noticeFinished);
          yield* worker.drain();
          if (delivered !== null) yield* Fiber.join(delivered);
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        const reads = after.turnItems.filter((item) =>
          statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
        );
        assert.equal(reads.length, 4);
        for (const read of reads) {
          assert.equal(read.status, explicitSteer ? "cancelled" : "completed");
          assert.equal(read.toolNonExecutionKind, explicitSteer ? "cancelled" : undefined);
          assert.equal(read.type === "dynamic_tool" && read.output === refusal, explicitSteer);
        }
        assert.equal(offers.length, 2);
        assert.equal(
          offers.filter((offer) => offer.priority === "now").length,
          explicitSteer ? 1 : 0,
        );
        if (!explicitSteer) {
          assert.equal(after.runs.length, 2);
          if (delivery === "child completion") {
            assert.equal(after.messages.filter((message) => message.id === messageId).length, 1);
            assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
          } else {
            assert.equal(
              after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
              1,
            );
          }
        }
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.equal(offers.length, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-automatic-delivery" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
);

it.effect("applies an effort change to the running Claude query without waiting for a turn", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-live-effort");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const flagSettings: unknown[] = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: modelSelection.instanceId,
      settings,
      environment: {},
      attachmentsDir: cwd,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(sessionId),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: (flags) =>
              Effect.sync(() => {
                flagSettings.push(flags);
              }),
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            getContextUsage: Effect.fail(
              new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                method: "getContextUsage",
                cause: new Error("Unsupported control request subtype"),
              }),
            ),
            stopTask: () => Effect.void,
            interrupt: Effect.die("an effort change must not interrupt the turn"),
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:live-effort");
      const high = { ...modelSelection, options: [{ id: "effort", value: "high" }] };
      const running = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:live-effort"),
        title: "Live effort",
        modelSelection: high,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first"),
        threadId,
        messageId: MessageId.make("first"),
        text: "Keep working.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      assert.deepEqual(flagSettings, []);

      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("medium"),
        threadId,
        modelSelection: { ...modelSelection, options: [{ id: "effort", value: "medium" }] },
      });
      yield* worker.drain();

      assert.deepEqual(flagSettings, [{ effortLevel: "medium", fastMode: null, ultracode: null }]);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-live-effort" },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);

const backgroundTaskStarted = (taskId: string) =>
  frame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    description: "Background build",
    is_backgrounded: true,
    task_type: "local_bash",
    uuid: `started-${taskId}`,
    session_id: sessionId,
  });

const backgroundTaskNotification = (taskId: string) =>
  frame({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `tool-${taskId}`,
    status: "completed",
    output_file: `/tmp/claude-replay/tasks/${taskId}.output`,
    summary: `Background build ${taskId} completed`,
    uuid: `notification-${taskId}`,
    session_id: sessionId,
  });

const wakeAssistant = (uuid: string) =>
  frame({
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content: [{ type: "text", text: `Background build finished (${uuid}).` }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

it.effect("offers a continuation for a later wake after a queued continuation is cancelled", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-cancelled-continuation");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
      const done = yield* Deferred.make<void>();
      processed.set(message, done);
      yield* Queue.offer(sdkMessages, message);
      yield* Deferred.await(done);
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const continuations: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
    const services =
      yield* Effect.context<
        Effect.Services<ReturnType<typeof ClaudeAdapterV2.makeClaudeAdapterV2>>
      >();
    const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem,
          path,
          random,
          idAllocator,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => continuations.push(request)).pipe(
                Effect.andThen(requests.offer(request)),
              ),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                // Resolve each frame's Deferred once the adapter pulls the next one.
                messages: Stream.fromQueue(sdkMessages).pipe(
                  Stream.flatMap((message) =>
                    Stream.make(message).pipe(
                      Stream.concat(
                        Stream.fromEffect(
                          Effect.suspend(() => {
                            const done = processed.get(message);
                            return done === undefined
                              ? Effect.void
                              : Deferred.succeed(done, undefined);
                          }),
                        ).pipe(Stream.drain),
                      ),
                    ),
                  ),
                ),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.die("unexpected MCP resource read"),
                callMcpTool: () => Effect.die("unexpected MCP tool call"),
                listPermissionRules: Effect.die("unexpected permission rules read"),
                getContextUsage: Effect.fail(
                  new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "getContextUsage",
                    cause: new Error("Unsupported control request subtype"),
                  }),
                ),
                stopTask: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            subagentModel: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        }).pipe(Effect.provideContext(services));
        return [adapter];
      }),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:cancelled-continuation");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const runUpdated = (messageId: string, status: string) =>
        watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === messageId &&
            event.payload.status === status,
        );
      // A user turn that leaves a background task running when it ends.
      const userTurnWithBackgroundTask = Effect.fnUntraced(function* (id: string, taskId: string) {
        const running = yield* runUpdated(id, "running");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: "Run the build in the background.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const waiting = yield* runUpdated(id, "waiting");
        yield* Queue.offer(sdkMessages, backgroundTaskStarted(taskId));
        yield* Queue.offer(sdkMessages, result(`result-${id}`, false));
        yield* Fiber.join(waiting);
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:cancelled-continuation"),
        title: "Cancelled continuation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });

      // The first run is still finalizing when its background task wakes Claude.
      yield* userTurnWithBackgroundTask("first", "build-1");
      const queued = yield* watch(
        (event) => event.type === "run.created" && event.payload.status === "queued",
      );
      yield* offerAndWait(backgroundTaskNotification("build-1"));
      yield* offerAndWait(wakeAssistant("wake-1"));
      yield* Fiber.join(queued);
      assert.lengthOf(continuations, 1);
      const continuationRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      );
      assert.ok(continuationRun !== undefined);
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel"),
        threadId,
        runId: continuationRun.id,
      });
      yield* offerAndWait(result("wake-1-result", false));
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      const idle = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(idle.runs.find((run) => run.id === continuationRun.id)?.status, "cancelled");
      assert.isFalse(idle.runs.some((run) => run.status === "queued"));

      yield* userTurnWithBackgroundTask("second", "build-2");
      yield* worker.drain();
      // The second user run has completed, so this continuation starts without queueing.
      const isContinuationRun = (event: OrchestrationV2DomainEvent, type: string, status: string) =>
        (event.type === "run.created" || event.type === "run.updated") &&
        event.type === type &&
        event.payload.status === status &&
        event.payload.userMessageId !== MessageId.make("first") &&
        event.payload.userMessageId !== MessageId.make("second");
      const secondCreated = yield* watch((event) =>
        isContinuationRun(event, "run.created", "starting"),
      );
      const secondRunning = yield* watch((event) =>
        isContinuationRun(event, "run.updated", "running"),
      );
      yield* offerAndWait(backgroundTaskNotification("build-2"));
      yield* offerAndWait(wakeAssistant("wake-2"));
      assert.lengthOf(
        continuations,
        2,
        "the wake after a cancelled queued continuation must offer a new continuation",
      );
      yield* Fiber.join(secondCreated);
      yield* worker.drain();
      yield* Fiber.join(secondRunning);
      const secondContinuation = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "running",
      );
      assert.ok(secondContinuation !== undefined);
      const secondWaiting = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === secondContinuation.id &&
          event.payload.status === "waiting",
      );
      yield* offerAndWait(result("wake-2-result", false));
      yield* Fiber.join(secondWaiting);
      yield* worker.drain();
      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        settled.runs.find((run) => run.id === secondContinuation.id)?.status,
        "completed",
      );
      assert.deepEqual(
        settled.turnItems.flatMap((item) =>
          item.runId === secondContinuation.id && item.type === "assistant_message"
            ? [item.text]
            : [],
        ),
        ["Background build finished (wake-2)."],
        "the continuation must carry only its own wake's output",
      );
      assert.lengthOf(continuations, 2, "two wakes must offer exactly two continuations");
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-cancelled-continuation" },
          registry,
          { runEffectWorker: false, runContinuationWorker: true },
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
