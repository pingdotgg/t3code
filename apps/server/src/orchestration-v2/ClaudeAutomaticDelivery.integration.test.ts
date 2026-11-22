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
  type RunId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
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
  "delivers %s without Claude cancelling the pending tool calls in its batch",
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
              renameSession: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
              mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
              reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
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
        const queuesBehindActiveTurn = delivery === "scheduled message";
        assert.equal(batchAbort.signal.aborted, false);
        assert.lengthOf(offers, queuesBehindActiveTurn ? 1 : 2);
        if (!queuesBehindActiveTurn) assert.equal(offers[1]?.priority, "next");
        const finished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === parent.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, toolResult("build", false));
        for (const id of statusIds)
          yield* Queue.offer(sdkMessages, toolResult(id, batchAbort.signal.aborted));
        yield* Queue.offer(
          sdkMessages,
          delivery === "child completion"
            ? frame({ ...result("completed", false), user_message_uuid: offers[1]!.uuid })
            : result("completed", false),
        );
        yield* Fiber.join(finished);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (queuesBehindActiveTurn) {
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
          const noticeFinished = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, result("notice-completed", false));
          yield* Fiber.join(noticeFinished);
          yield* worker.drain();
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        const reads = after.turnItems.filter((item) =>
          statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
        );
        assert.equal(reads.length, 4);
        for (const read of reads) {
          assert.equal(read.status, "completed");
          assert.equal(read.toolNonExecutionKind, undefined);
          assert.equal(read.type === "dynamic_tool" && read.output === refusal, false);
        }
        assert.lengthOf(offers, 2);
        assert.equal(offers.filter((offer) => offer.priority === "now").length, 0);
        if (delivery === "child completion") {
          assert.lengthOf(after.runs, 1);
          assert.deepEqual(
            after.messages
              .filter((message) => message.id === messageId)
              .map((message) => message.runId),
            [parent.id],
          );
          assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
        } else if (queuesBehindActiveTurn) {
          assert.lengthOf(after.runs, 2);
          assert.equal(
            after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
            1,
          );
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
            renameSession: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
            mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
            reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
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

const renamedClaudeSessionTitles = (options: { readonly renameDuringStartup: boolean }) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-live-rename");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const renames: string[] = [];
    const startupEntered = yield* Deferred.make<void>();
    const startupReleased = yield* Deferred.make<void>();
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
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            renameSession: (title) =>
              Effect.sync(() => {
                renames.push(title);
              }),
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
            mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
            reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            getContextUsage: Effect.fail(
              new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                method: "getContextUsage",
                cause: new Error("Unsupported control request subtype"),
              }),
            ),
            stopTask: () => Effect.void,
            interrupt: Effect.die("a rename must not interrupt the turn"),
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:live-rename");
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
        projectId: ProjectId.make("project:live-rename"),
        title: "Seed title",
        modelSelection,
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
      const rename = orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "Renamed title",
      });
      if (options.renameDuringStartup) {
        const starting = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(startupEntered);
        yield* rename;
        yield* Deferred.succeed(startupReleased, undefined);
        yield* Fiber.join(starting);
        yield* Fiber.join(running);
      } else {
        yield* worker.drain();
        yield* Fiber.join(running);
        assert.deepEqual(renames, []);
        yield* rename;
      }
      yield* worker.drain();
      return renames;
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-live-rename" },
          ProviderAdapterRegistry.layerSingle({
            ...adapter,
            openSession: (input) =>
              options.renameDuringStartup
                ? Deferred.succeed(startupEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(startupReleased)),
                    Effect.andThen(adapter.openSession(input)),
                  )
                : adapter.openSession(input),
          }),
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
  );

it.effect("renames the running Claude session when the thread is renamed mid-turn", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* renamedClaudeSessionTitles({ renameDuringStartup: false }), [
      "Renamed title",
    ]);
  }),
);

it.effect("renames the Claude session when the thread is renamed while it starts", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* renamedClaudeSessionTitles({ renameDuringStartup: true }), [
      "Renamed title",
    ]);
  }),
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
                renameSession: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.die("unexpected MCP resource read"),
                callMcpTool: () => Effect.die("unexpected MCP tool call"),
                mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
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

// A steer Claude never read runs as the next turn, between the messages sent before and after
// it, even when they share a millisecond and the later one picks another model.
it.effect.each([
  "Claude cancels it twice",
  "the Claude process exits",
  "the server restarts",
  "Claude cancels it and the user stops",
] as const)("handles an unread steer when %s", (outcome) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-unread-steer");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const offers: SDKUserMessage[] = [];
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
            offer: (message) => Effect.sync(() => void offers.push(message)),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            renameSession: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
            mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
            reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            getContextUsage: Effect.fail(
              new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                method: "getContextUsage",
                cause: new Error("Unsupported control request subtype"),
              }),
            ),
            stopTask: () => Effect.void,
            interrupt: Queue.shutdown(sdkMessages),
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
      const threadId = ThreadId.make("thread:unread-steer");
      const steerId = MessageId.make("steer");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const settled = (runId: RunId, status: "waiting") =>
        watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === runId &&
            event.payload.status === status,
        );
      const pending = () =>
        watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerId &&
            event.payload.status === "pending",
        );
      const answer = (offer: SDKUserMessage) =>
        Queue.offer(
          sdkMessages,
          frame({
            ...(result(`result-${offer.uuid}`, false) as object),
            user_message_uuid: offer.uuid,
          }),
        );
      const cancel = (offer: SDKUserMessage) =>
        Queue.offer(
          sdkMessages,
          frame({
            type: "command_lifecycle",
            command_uuid: offer.uuid,
            state: "cancelled",
            uuid: `cancelled-${offer.uuid}`,
            session_id: sessionId,
          }),
        );
      const offeredText = (offer: SDKUserMessage | undefined) =>
        JSON.stringify(offer?.message.content ?? null);
      const queued = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
        projection.runs
          .filter((run) => run.status === "queued")
          .toSorted(
            (left, right) =>
              (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
          ),
      );
      const queuedOrder = Effect.map(queued, (runs) =>
        runs.map((run) => [run.userMessageId, run.queueHeld === true]),
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:unread-steer"),
        title: "Unread steer",
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
      const send = (
        id: string,
        dispatchMode:
          | { readonly type: "start_immediately" | "queue_after_active" }
          | { readonly type: "steer_active"; readonly targetRunId: RunId },
        model?: string,
      ) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: `Message ${id}`,
          attachments: [],
          ...(model === undefined ? {} : { modelSelection: { ...modelSelection, model } }),
          dispatchMode,
          createdBy: "user",
          creationSource: "web",
        });
      yield* send("first", { type: "start_immediately" });
      yield* worker.drain();
      yield* Fiber.join(running);
      const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* send("before", { type: "queue_after_active" });
      const unread = yield* pending();
      yield* send("steer", { type: "steer_active", targetRunId: parent.id });
      yield* worker.drain();
      yield* Fiber.join(unread);
      yield* send("after", { type: "queue_after_active" }, "claude-opus-4-1");
      assert.deepEqual(
        offers.map((offer) => offer.priority),
        [undefined, "next"],
      );

      if (outcome === "Claude cancels it twice") {
        const ended = yield* settled(parent.id, "waiting");
        const nextRunning = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.runAttemptId !== parent.activeAttemptId,
        );
        // The next run starts from an async reaction to the parent's capture, which drain does not await.
        const nextStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id !== parent.id &&
            event.payload.status === "starting",
        );
        yield* answer(offers[0]!);
        yield* cancel(offers[1]!);
        yield* Fiber.join(ended);
        yield* worker.drain();
        yield* Fiber.join(nextStarting);
        yield* worker.drain();
        yield* Fiber.join(nextRunning);
        // The older message runs first; the steer waits right behind it on its own model.
        const behind = yield* queued;
        assert.deepEqual(
          behind.map((run) => run.userMessageId),
          [steerId, MessageId.make("after")],
        );
        assert.deepEqual(behind[0]?.modelSelection, modelSelection);
        assert.include(offeredText(offers[2]), "Message before");
        // Promoted into that run, Claude drops it again; it is queued again, then reaches Claude.
        const before = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("before"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: behind[0]!.id,
          targetRunId: before.id,
        });
        yield* worker.drain();
        assert.equal(offers[3]?.priority, "next");
        const beforeEnded = yield* settled(before.id, "waiting");
        const steerStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === steerId &&
            event.payload.status === "starting",
        );
        yield* answer(offers[2]!);
        yield* cancel(offers[3]!);
        yield* Fiber.join(beforeEnded);
        yield* worker.drain();
        yield* Fiber.join(steerStarting);
        yield* worker.drain();
        assert.deepEqual(yield* queuedOrder, [[MessageId.make("after"), false]]);
        assert.equal(offers.length, 5);
        assert.equal(offers[4]?.priority, undefined);
        assert.include(offeredText(offers[4]), "Message steer");
        return;
      }

      if (outcome === "the Claude process exits") {
        const requeued = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === steerId &&
            event.payload.status === "queued",
        );
        yield* Queue.shutdown(sdkMessages);
        yield* Fiber.join(requeued);
        yield* worker.drain();
        // The provider failure holds the queue, the follow-up included, until someone resumes it.
        assert.deepEqual(yield* queuedOrder, [
          [MessageId.make("before"), true],
          [steerId, true],
          [MessageId.make("after"), true],
        ]);
        assert.equal(offers.length, 2);
        return;
      }

      if (outcome === "Claude cancels it and the user stops") {
        yield* cancel(offers[1]!);
        const dropped = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerId &&
            event.payload.status === "cancelled",
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: parent.id,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* Fiber.join(dropped);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.turnItems.find((item) => item.type === "user_message" && item.messageId === steerId)
            ?.status,
          "cancelled",
        );
        assert.isTrue(
          after.turnItems.some(
            (item) => item.type === "system_notice" && item.message?.includes("Message steer"),
          ),
        );
        assert.deepEqual(yield* queuedOrder, [
          [MessageId.make("before"), true],
          [MessageId.make("after"), true],
        ]);
        return;
      }

      // Recovery cancels the run, holds the queue and leaves the unread steer pending.
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:runtime-reconcile:startup:unread-steer"),
        events: projection.runs.map((run, index) => ({
          id: EventId.make(`recovered-run-${index}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === parent.id
              ? { ...run, status: "cancelled" as const, completedAt: now }
              : { ...run, queueHeld: true },
        })),
      });
      yield* orchestrator.recoverDelegatedTasks;
      yield* worker.drain();
      assert.deepEqual(yield* queuedOrder, [
        [MessageId.make("before"), true],
        [steerId, true],
        [MessageId.make("after"), true],
      ]);
      assert.equal(offers.length, 2);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-unread-steer" },
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

// SIGKILL ends the stream without a frame. SIGTERM makes the CLI stop its tasks first; the
// empty roster level can come before or after the stop notification.
const exitWhileIdle = (options: {
  readonly awaited: boolean;
  readonly signal: "SIGKILL" | "SIGTERM" | "SIGTERM-roster-first";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { awaited, signal } = options;
      const cwd = yield* checkpointWorkspace("claude-idle-exit-awaited-task");
      const processes: Array<Queue.Queue<SDKMessage, Cause.Done>> = [];
      const offers: SDKUserMessage[] = [];
      const taskId = "b8sleep180";
      const registry = Layer.unwrap(
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: modelSelection.instanceId,
            settings,
            environment: {},
            attachmentsDir: cwd,
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            random: yield* SecureRandom.SecureRandom,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
            queryRunner: {
              allocateSessionId: Effect.succeed(sessionId),
              open: () =>
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
                  processes.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: (message: SDKUserMessage) =>
                      Effect.sync(() => void offers.push(message)),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    renameSession: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    mcpServerStatus: Effect.succeed([]),
                    readMcpResource: () => Effect.die("unexpected MCP resource read"),
                    callMcpTool: () => Effect.die("unexpected MCP tool call"),
                    mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                    mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                    reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                    listPermissionRules: Effect.die("unexpected permission rules read"),
                    getContextUsage: Effect.fail(
                      new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                        method: "getContextUsage",
                        cause: new Error("Unsupported control request subtype"),
                      }),
                    ),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              subagentModel: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          return ProviderAdapterRegistry.layerSingle(adapter);
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread:idle-exit-awaited-task");
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
          projectId: ProjectId.make("project:idle-exit-awaited-task"),
          title: "Idle exit",
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
          text: "Sleep 180 seconds in the background and wait for it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const firstProcess = processes[0]!;
        const rostered = yield* watch(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.pendingBackgroundTasks?.some((task) => task.taskId === taskId) === true,
        );
        yield* Queue.offer(
          firstProcess,
          frame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: taskId, task_type: "local_bash", description: "sleep 180" }],
            uuid: "roster",
            session_id: sessionId,
          }),
        );
        yield* Fiber.join(rostered);
        if (awaited) {
          const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads"]);
          const providerThread = records.providerThreads[0]!;
          const runtime = yield* sessions.get(providerThread.providerSessionId!);
          if (Option.isNone(runtime) || runtime.value.awaitBackgroundTasks === undefined) {
            return yield* Effect.die("Claude runtime must accept background waits");
          }
          const awaitedRoster = yield* watch(
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.pendingBackgroundTasks?.some((task) => task.awaited === true) === true,
          );
          yield* runtime.value.awaitBackgroundTasks({
            providerThread,
            taskIds: [taskId],
            awaited: true,
          });
          yield* Fiber.join(awaitedRoster);
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            (event.payload.status === "waiting" || event.payload.status === "completed"),
        );
        yield* Queue.offer(firstProcess, result("waiting-on-sleep", false));
        yield* Fiber.join(settled);
        yield* worker.drain();
        const beforeExit = yield* orchestrator.getThreadProjection(threadId);
        const firstRun = beforeExit.runs[0]!;
        assert.deepEqual(
          beforeExit.providerThreads[0]?.pendingBackgroundTasks?.map((task) => [
            task.taskId,
            task.awaited,
          ]),
          [[taskId, awaited ? true : undefined]],
        );

        const recorded = yield* watch((event) => event.type === "run.background-work-cancelled");
        const woken = yield* watch(
          (event) => event.type === "run.updated" && event.payload.id !== firstRun.id,
        );
        if (signal !== "SIGKILL") {
          const notification = frame({
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            status: "stopped",
            output_file: "",
            summary: "sleep 180",
            uuid: "stopped",
            session_id: sessionId,
          });
          const emptyRoster = frame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "roster-empty",
            session_id: sessionId,
          });
          const killed = frame({
            type: "system",
            subtype: "task_updated",
            task_id: taskId,
            patch: { status: "killed", end_time: 1 },
            uuid: "killed",
            session_id: sessionId,
          });
          yield* Queue.offerAll(
            firstProcess,
            signal === "SIGTERM"
              ? [notification, killed, emptyRoster]
              : [emptyRoster, notification, killed],
          );
        }
        // The CLI exits while the thread is idle, after its last frames; the T3 server keeps running.
        yield* Queue.end(firstProcess);
        yield* Fiber.join(recorded);
        yield* worker.drain();

        const afterExit = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterExit.runs
            .find((run) => run.id === firstRun.id)
            ?.restartCancelledBackgroundWork?.map((work) => work.id),
          [taskId],
          "the run must record the awaited task the exited process took with it",
        );
        // Drained effects already dispatched any wake, so a missing one fails here instead of hanging.
        assert.equal(
          afterExit.runs.some((run) => run.id !== firstRun.id),
          awaited,
          "only awaited work wakes the agent without a user message",
        );
        if (!awaited) return;
        yield* Fiber.join(woken);
        yield* worker.drain();
        const afterWake = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(
          afterWake.runs.filter((run) => run.id !== firstRun.id),
          1,
          "the agent must be woken exactly once",
        );
        assert.lengthOf(offers.slice(1), 1);
        assert.include(
          JSON.stringify(offers[1]?.message),
          taskId,
          "the wake must carry a note naming the lost task",
        );
        assert.equal(
          afterWake.messages.filter((message) => message.createdBy === "user").length,
          1,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-idle-exit-awaited-task" },
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

it.effect("wakes the agent when Claude's process exits while it awaits background work", () =>
  exitWhileIdle({ awaited: true, signal: "SIGKILL" }),
);

it.effect("wakes the agent when Claude stops awaited background work before exiting", () =>
  exitWhileIdle({ awaited: true, signal: "SIGTERM" }),
);

it.effect("wakes the agent when Claude empties its roster before stopping awaited work", () =>
  exitWhileIdle({ awaited: true, signal: "SIGTERM-roster-first" }),
);

it.effect("records but does not wake for an unawaited shell lost when Claude's process exits", () =>
  exitWhileIdle({ awaited: false, signal: "SIGKILL" }),
);
