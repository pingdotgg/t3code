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
const sessionId = "orphaned-subagent-session";
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const frame = (value: unknown) => value as SDKMessage;
const stoppedSummary = "Background agent didn't finish before the previous session ended";
const successResult = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "The review continues in the background.",
    stop_reason: "end_turn",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

// Only the SDK stream is replayed; adapter, session manager, ingestor,
// orchestrator, and SQLite projections are the production ones.
it.effect.each(["active", "idle"] as const)(
  "settles an orphaned task receipt while the replacement process is %s",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-orphaned-subagent");
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
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
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
          const threadId = ThreadId.make("thread:orphaned-subagent");
          // Subscribe before offering the frame so a fast commit is not missed.
          const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            Effect.gen(function* () {
              const afterSequence = yield* sink.latestSequence();
              return yield* sink.stream({ afterSequence }).pipe(
                Stream.filter((stored) => predicate(stored.event)),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            });
          const sendMessage = (id: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(id),
              text: "Continue.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:orphaned-subagent"),
            title: "Orphaned subagent",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* sendMessage("first");
          yield* worker.drain();
          const first = processes[0]!;
          const started = yield* awaitEvent(
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
              uuid: "old-task-started",
              session_id: sessionId,
            }),
          );
          yield* Fiber.join(started);
          const firstTurnDone = yield* awaitEvent(
            (event) =>
              event.type === "provider-turn.updated" && event.payload.status === "completed",
          );
          yield* Queue.offer(first, successResult("first-result"));
          yield* Fiber.join(firstTurnDone);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadProjection(threadId);
          const task = before.subagents.find(
            (entry) => entry.nativeTaskRef?.nativeId === "old-task",
          )!;
          assert.equal(task.status, "running");

          // The replacement process starts with no record of the old task.
          yield* manager.release({
            providerSessionId: before.providerSessions.at(-1)!.id,
            reason: "runtime_error",
            detail: "fixture process exited",
          });
          yield* sendMessage("second");
          yield* worker.drain();
          assert.lengthOf(processes, 2);
          const second = processes[1]!;
          if (state === "idle") {
            const secondTurnDone = yield* awaitEvent(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "completed",
            );
            yield* Queue.offer(second, successResult("second-result"));
            yield* Fiber.join(secondTurnDone);
            yield* worker.drain();
          }
          // A later frame's persisted item marks the notification as consumed.
          const consumed = yield* awaitEvent((event) =>
            state === "idle"
              ? event.type === "provider-thread.updated" &&
                event.payload.pendingBackgroundTasks?.some(
                  (task) => task.taskId === "idle-barrier",
                ) === true
              : event.type === "turn-item.updated" &&
                event.payload.nativeItemRef?.nativeId === "barrier-tool",
          );
          yield* Queue.offer(
            second,
            frame({
              type: "system",
              subtype: "task_notification",
              task_id: "old-task",
              status: "stopped",
              reason: "worker_restart",
              summary: stoppedSummary,
              output_file: "",
              uuid: "old-task-stopped",
              session_id: sessionId,
            }),
          );
          if (state === "idle") {
            yield* Queue.offer(
              second,
              frame({
                type: "system",
                subtype: "background_tasks_changed",
                tasks: [
                  {
                    task_id: "idle-barrier",
                    task_type: "local_bash",
                    description: "Receipt consumed",
                  },
                ],
                uuid: "idle-barrier",
                session_id: sessionId,
              }),
            );
          } else {
            yield* Queue.offer(
              second,
              frame({
                type: "assistant",
                uuid: "barrier",
                session_id: sessionId,
                parent_tool_use_id: null,
                message: {
                  id: "barrier-message",
                  role: "assistant",
                  type: "message",
                  model: modelSelection.model,
                  content: [
                    {
                      type: "tool_use",
                      id: "barrier-tool",
                      name: "Bash",
                      input: { command: "true" },
                    },
                  ],
                  stop_reason: "tool_use",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              }),
            );
          }
          yield* Fiber.join(consumed);

          const after = yield* orchestrator.getThreadProjection(threadId);
          const ended = after.subagents.find((entry) => entry.id === task.id)!;
          assert.equal(ended.status, "cancelled");
          assert.equal(ended.runId, task.runId);
          assert.equal(ended.providerInstanceId, task.providerInstanceId);
          assert.equal(ended.result, stoppedSummary);
          assert.equal(after.nodes.find((node) => node.id === task.id)?.status, "cancelled");
          const item = after.turnItems.find(
            (entry) => entry.type === "subagent" && entry.subagentId === task.id,
          );
          assert.equal(item?.status, "cancelled");
          const child = yield* orchestrator.getThreadProjection(task.childThreadId!);
          const childRoots = child.nodes.filter((node) => node.kind === "root_turn");
          assert.isAbove(childRoots.length, 0);
          assert.isTrue(childRoots.every((node) => node.status === "cancelled"));
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-orphaned-subagent" },
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
