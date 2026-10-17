import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const sessionId = "stopped-task-native-session";
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
// Replay only the external SDK boundary. The adapter, session pump, ingestor,
// orchestrator and SQLite projections use their production implementations.
const frame = (value: unknown) => value as SDKMessage;

it.effect.each(["transcript", "sdk"] as const)(
  "reconciles a %s stopped receipt through a replacement Claude process and durable projections",
  (receiptKind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-stopped-task");
        const processes: Array<Queue.Queue<SDKMessage>> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings: yield* decodeClaudeSettings({}),
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            assertComplete: Effect.void,
            subagentLaunchToolUseId: () => Effect.succeed(null),
            open: () =>
              Effect.gen(function* () {
                const messages = yield* Queue.unbounded<SDKMessage>();
                processes.push(messages);
                return {
                  messages: Stream.fromQueue(messages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(messages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const threadId = ThreadId.make("thread:stopped-task");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            Effect.gen(function* () {
              // Capture the cursor before offering an SDK frame; a lazily opened
              // live tail can miss a fast receipt that already committed.
              const afterSequence = yield* sink.latestSequence();
              return yield* sink.stream({ afterSequence }).pipe(
                Stream.filter((stored) => predicate(stored.event)),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            });
          const dispatch = (id: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(id),
              text: "Continue the review.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:stopped-task"),
            title: "Stopped task",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* dispatch("first");
          yield* worker.drain();
          assert.lengthOf(processes, 1);
          const first = processes[0]!;
          const spawned = yield* watch(
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.nativeTaskRef?.nativeId === "old-task",
          );
          yield* Queue.offer(
            first,
            frame({
              type: "system",
              subtype: "task_started",
              task_id: "old-task",
              tool_use_id: "old-tool",
              description: "Review recent changes",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Review recent changes.",
              uuid: "spawn-old-task",
              session_id: sessionId,
            }),
          );
          yield* Fiber.join(spawned);
          const finished = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" && event.payload.status === "completed",
          );
          yield* Queue.offer(
            first,
            frame({
              type: "result",
              subtype: "success",
              uuid: "first-completed",
              session_id: sessionId,
              is_error: false,
              num_turns: 1,
              result: "Review continues in the background.",
              stop_reason: "end_turn",
              permission_denials: [],
              duration_ms: 1,
              duration_api_ms: 1,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {},
            }),
          );
          yield* Fiber.join(finished);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadProjection(threadId);
          const task = before.subagents.find(
            (entry) => entry.nativeTaskRef?.nativeId === "old-task",
          );
          assert.isDefined(task);
          assert.equal(task!.status, "running");
          const providerSessionId = before.providerSessions.at(-1)!.id;
          // Destroy the owning runtime; the replacement has an empty native-task registry.
          yield* manager.release({
            providerSessionId,
            reason: "runtime_error",
            detail: "fixture process exited",
          });
          yield* dispatch("resume");
          yield* worker.drain();
          assert.lengthOf(processes, 2);
          const second = processes[1]!;
          yield* Queue.offer(
            second,
            frame({
              type: "system",
              subtype: "init",
              uuid: "replacement-init",
              session_id: sessionId,
            }),
          );
          const settled = yield* watch(
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.id === task!.id &&
              event.payload.status === "cancelled",
          );
          const notification =
            receiptKind === "transcript"
              ? {
                  type: "user",
                  isSynthetic: true,
                  parent_tool_use_id: null,
                  session_id: sessionId,
                  uuid: "stopped-notification",
                  message: {
                    role: "user",
                    content:
                      "<task-notification><task-id>old-task</task-id><status>stopped</status><summary>Previous session ended</summary></task-notification>",
                  },
                }
              : {
                  type: "system",
                  subtype: "task_notification",
                  task_id: "old-task",
                  status: "stopped",
                  summary: "Previous session ended",
                  session_id: sessionId,
                  uuid: "stopped-notification",
                };
          yield* Queue.offer(second, frame(notification));
          yield* Fiber.join(settled);
          const after = yield* orchestrator.getThreadProjection(threadId);
          const updated = after.subagents.find((entry) => entry.id === task!.id)!;
          assert.equal(updated.status, "cancelled");
          assert.equal(updated.providerInstanceId, task!.providerInstanceId);
          assert.equal(updated.result, "Previous session ended");
          assert.isNotNull(updated.completedAt);
          const items = after.turnItems.filter((item) => item.nodeId === task!.id);
          assert.isAbove(items.length, 0);
          assert.isTrue(
            items.every((item) => item.status === "cancelled" && item.completedAt !== null),
          );
          assert.isNotNull(task!.childThreadId);
          const child = yield* orchestrator.getThreadProjection(task!.childThreadId!);
          const roots = child.nodes.filter((node) => node.nativeItemRef?.nativeId === "old-task");
          assert.isAbove(roots.length, 0);
          assert.isTrue(roots.every((node) => node.status === "cancelled"));
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-stopped-task" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
);
