import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const nativeSessionId = "account-switch-wake-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const firstAccount: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const secondAccount: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-second-account"),
  model: "claude-sonnet-4-6",
};

function frame(value: Record<string, unknown>): SDKMessage {
  return { session_id: nativeSessionId, ...value } as unknown as SDKMessage;
}

const resultFrame = (uuid: string, text: string, wake = false) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    ...(wake ? { origin: { kind: "task-notification" } } : {}),
  });

const assistantFrame = (uuid: string, text: string) =>
  frame({
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      type: "message",
      model: firstAccount.model,
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

const backgroundBashStarted = frame({
  type: "system",
  subtype: "task_started",
  task_id: "bash-build",
  tool_use_id: "toolu_bash_build",
  description: "Build in the background",
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "bash-started",
});
// Claude may publish the emptied roster before the notification that owes a wake turn.
const emptyRoster = frame({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [],
  uuid: "roster-empty",
});
const bashNotification = frame({
  type: "system",
  subtype: "task_notification",
  task_id: "bash-build",
  tool_use_id: "toolu_bash_build",
  status: "completed",
  output_file: "/tmp/claude-replay/tasks/bash-build.output",
  summary: 'Background command "Build in the background" completed (exit code 0)',
  uuid: "bash-notification",
});
const WAKE_REPLY = "BUILD_REPORT_DELIVERED";

const makeAccount = Effect.fn("makeAccount")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly continuations: Queue.Queue<ProviderContinuationRequests.ProviderContinuationRequest>;
  readonly closed: Array<string>;
}) {
  const processes: Array<Queue.Queue<SDKMessage>> = [];
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: input.instanceId,
    settings,
    environment: {},
    attachmentsDir: input.cwd,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    random: yield* SecureRandom.SecureRandom,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    continuationRequests: {
      offer: (request) => Queue.offer(input.continuations, request).pipe(Effect.asVoid),
    },
    queryRunner: {
      allocateSessionId: Effect.succeed(nativeSessionId),
      open: () =>
        Effect.gen(function* () {
          const messages = yield* Queue.unbounded<SDKMessage>();
          processes.push(messages);
          return {
            messages: Stream.fromQueue(messages),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.sync(() => void input.closed.push(input.instanceId)).pipe(
              Effect.andThen(Queue.shutdown(messages)),
            ),
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      subagentModel: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  return { adapter, processes };
});

// regression: #32296 an account switch must not close the CLI that still owes a wake reply
it.live.each([
  "switch sent after",
  "switch queued behind",
  "hand-off sent after",
  "hand-off still running after",
] as const)("delivers a Claude background reply across an account %s the turn", (variant) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-account-switch-wake");
    const continuations =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const closed: Array<string> = [];
    const first = yield* makeAccount({
      instanceId: firstAccount.instanceId,
      cwd,
      continuations,
      closed,
    });
    const second = yield* makeAccount({
      instanceId: secondAccount.instanceId,
      cwd,
      continuations,
      closed,
    });
    const adapters = [first.adapter, second.adapter];
    // Two accounts of one Claude install resume each other's native history; separate installs hand off.
    const handsOff = variant.startsWith("hand-off");
    const registry = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        get: (instanceId) => {
          const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
          return adapter === undefined
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              )
            : Effect.succeed(adapter);
        },
        list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
        getMetadata: (instanceId) =>
          Effect.succeed({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            continuationKey: handsOff
              ? `claude:${instanceId}`
              : "claude:shared-native-account-history",
            enabled: true,
            capabilities: ClaudeProviderCapabilitiesV2,
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:claude-account-switch-wake");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const runStatus = (messageId: string, status: string) =>
        watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === messageId &&
            event.payload.status === status,
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:claude-account-switch-wake"),
        title: "Account switch during a background build",
        modelSelection: firstAccount,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const queued = variant === "switch queued behind";
      const send = (ordinal: number, modelSelection: ModelSelection) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send-${ordinal}`),
          threadId,
          messageId: MessageId.make(`send-${ordinal}`),
          text: `Prompt ${ordinal}`,
          attachments: [],
          modelSelection,
          dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

      const firstRunning = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* send(1, firstAccount);
      yield* worker.drain();
      yield* Fiber.join(firstRunning);
      if (queued) yield* send(2, secondAccount);
      const firstSettling = yield* runStatus("send-1", "waiting");
      const firstProcess = first.processes[0]!;
      yield* Queue.offer(firstProcess, backgroundBashStarted);
      yield* Queue.offer(firstProcess, resultFrame("turn-1", "Started the build."));
      yield* Fiber.join(firstSettling);
      yield* worker.drain();

      if (!queued) yield* send(2, secondAccount);
      yield* worker.drain();
      const deliverWake = (afterDispatch: Effect.Effect<unknown> = Effect.void) =>
        Effect.gen(function* () {
          yield* Queue.offer(firstProcess, bashNotification);
          yield* Queue.offer(firstProcess, assistantFrame("wake-assistant", WAKE_REPLY));
          yield* Queue.offer(firstProcess, resultFrame("wake-result", WAKE_REPLY, true));
          const request = yield* Queue.take(continuations);
          const wakeSettling = yield* runStatus("wake", "waiting");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("wake"),
            threadId,
            messageId: MessageId.make("wake"),
            text: request.detail ?? "Background task completed.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "provider",
            continuationProviderThreadId: request.providerThreadId,
            notification: request.notification ?? {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Background activity updated",
            },
          });
          yield* afterDispatch;
          yield* worker.drain();
          yield* Fiber.join(wakeSettling);
          yield* worker.drain();
        });
      if (handsOff) {
        // The second account runs beside the first, whose process still owes its reply.
        const finishSecond = Effect.gen(function* () {
          const secondSettling = yield* runStatus("send-2", "waiting");
          yield* Queue.offer(second.processes[0]!, resultFrame("turn-2", "Handoff complete."));
          yield* Fiber.join(secondSettling);
          yield* worker.drain();
        });
        assert.deepEqual(closed, []);
        // A reply that arrives during the second account's turn queues, then starts on its owner.
        if (variant === "hand-off sent after") {
          yield* finishSecond;
          yield* deliverWake();
        } else {
          yield* deliverWake(finishSecond);
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          after.messages.some((message) => message.text === WAKE_REPLY),
          "the wake reply must reach the thread",
        );
        assert.equal(
          after.runs.find((run) => run.userMessageId === "wake")?.providerInstanceId,
          firstAccount.instanceId,
        );
        // The reply drains on its owner; the user's pick stays on the second account.
        assert.deepEqual(after.thread.modelSelection, secondAccount);
        assert.equal(after.thread.providerInstanceId, secondAccount.instanceId);
        assert.notInclude(closed, secondAccount.instanceId);
        return;
      }
      const waiting = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        waiting.runs.map((run) => [run.providerInstanceId, run.status]),
        [
          [firstAccount.instanceId, "completed"],
          [secondAccount.instanceId, "queued"],
        ],
      );

      // The settled roster gives queue resumption its chance before the notification.
      const rosterSettled = yield* orchestrator
        .streamStoredEventsFrom({
          threadId,
          afterSequence: yield* (yield* EventSink.EventSinkV2).latestSequence(),
          eventType: "provider-thread.updated",
        })
        .pipe(Stream.runHead, Effect.forkScoped);
      yield* Queue.offer(firstProcess, emptyRoster);
      yield* Fiber.join(rosterSettled);
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      const afterRoster = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(closed, [], "the notification is still owed by the first account");
      assert.equal(afterRoster.runs[1]?.status, "queued");
      assert.equal(
        afterRoster.providerSessions.find(
          (session) => session.providerInstanceId === firstAccount.instanceId,
        )?.status,
        "ready",
      );

      // The notification and wake reply arrive on the still-open process.
      const switched = yield* runStatus("send-2", "running");
      yield* deliverWake();
      yield* Fiber.join(switched);
      yield* worker.drain();

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(
        after.messages.some((message) => message.text === WAKE_REPLY),
        "the wake reply must reach the thread",
      );
      const wakeRun = after.runs.find((run) => run.userMessageId === "wake");
      assert.equal(wakeRun?.providerInstanceId, firstAccount.instanceId);
      assert.equal(wakeRun?.status, "completed");
      assert.equal(
        after.runs.find((run) => run.userMessageId === "send-2")?.providerInstanceId,
        secondAccount.instanceId,
      );
      // Only now may the switch release the first account's process.
      assert.deepEqual(closed, [firstAccount.instanceId]);
      assert.lengthOf(second.processes, 1);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          {
            name: "claude-account-switch-wake",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: {
                type: "readOnly",
                access: { type: "fullAccess" },
                networkAccess: false,
              },
            },
          },
          registry,
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
