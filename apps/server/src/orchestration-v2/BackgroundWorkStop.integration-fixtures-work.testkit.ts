/**
 * Run, subagent and stalled-run fixtures for the BackgroundWorkStop integration tests.
 * Each factory receives the orchestrator, sink and thread it should act on so the
 * scenario body in the main testkit stays a sequence of statements and assertions.
 */
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export const makeSubagentThreadFactory = (deps: {
  readonly orchestrator: Orchestrator.OrchestratorV2Shape;
  readonly sink: EventSink.EventSinkV2Shape;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly now: DateTime.Utc;
  readonly instanceId: ProviderInstanceId;
  readonly modelSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  };
}) => {
  const { orchestrator, sink, threadId, cwd, now, instanceId, modelSelection } = deps;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        const subagentThread = (name: string) =>
          Effect.gen(function* () {
            const subagentThreadId = ThreadId.make(`thread:${name}`);
            const rootId = NodeId.make(`node:${name}-root`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create-${name}`),
              threadId: subagentThreadId,
              projectId: ProjectId.make("project:background-work-stop"),
              title: name,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "agent",
              creationSource: "provider",
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${name}-root`),
                  type: "node.updated",
                  threadId: subagentThreadId,
                  occurredAt: now,
                  payload: {
                    id: rootId,
                    threadId: subagentThreadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: rootId,
                    kind: "root_turn",
                    status: "running",
                    countsForRun: false,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: now,
                    completedAt: null,
                  },
                },
              ],
            });
            return { threadId: subagentThreadId, rootId };
          });

  return { watch, subagentThread };
};

export const makeSettledRunFactory = (deps: {
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly instanceId: ProviderInstanceId;
  readonly modelSelection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  };
  readonly driver: ProviderAdapter.ProviderAdapterV2SessionRuntime["driver"];
  readonly reviewerThreadId: ThreadId;
}) => {
  const { threadId, now, instanceId, modelSelection, driver, reviewerThreadId } = deps;
        const settledRun = (input: {
          readonly ordinal: number;
          readonly providerThreadId: ProviderThreadId;
          readonly runningItem?: {
            readonly id: TurnItemId;
            readonly kind: "command" | "subagent";
          };
        }) => {
          const runId = RunId.make(`run:${input.ordinal}`);
          const attemptId = RunAttemptId.make(`attempt:${input.ordinal}`);
          const nodeId = NodeId.make(`node:${input.ordinal}`);
          const providerTurnId = ProviderTurnId.make(`provider-turn:${input.ordinal}`);
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make(`run:${input.ordinal}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: input.ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: input.providerThreadId,
                userMessageId: MessageId.make(`message:${input.ordinal}`),
                rootNodeId: nodeId,
                activeAttemptId: attemptId,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`node:${input.ordinal}`),
              type: "node.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`attempt:${input.ordinal}`),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: nodeId,
                providerInstanceId: instanceId,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`provider-turn:${input.ordinal}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId: input.providerThreadId,
                nodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: input.ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ];
          const item = input.runningItem;
          if (item !== undefined) {
            const base = {
              id: item.id,
              threadId,
              runId,
              nodeId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal * 100,
              status: "running",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } as const;
            events.push({
              id: EventId.make(`item:${input.ordinal}`),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: now,
              payload:
                item.kind === "command"
                  ? { ...base, type: "command_execution", input: "vp run test --watch" }
                  : {
                      ...base,
                      providerThreadId: ProviderThreadId.make("provider-thread:codex-subagent"),
                      type: "subagent",
                      subagentId: NodeId.make(`subagent:${input.ordinal}`),
                      origin: "provider_native",
                      driver,
                      providerInstanceId: instanceId,
                      childThreadId: reviewerThreadId,
                      prompt: "Review the change",
                      result: null,
                    },
            });
            if (item.kind === "subagent") {
              events.push({
                id: EventId.make(`subagent:${input.ordinal}`),
                type: "subagent.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  ...base,
                  id: NodeId.make(`subagent:${input.ordinal}`),
                  parentNodeId: nodeId,
                  origin: "provider_native",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: reviewerThreadId,
                  nativeTaskRef: null,
                  prompt: "Review the change",
                  model: null,
                  result: null,
                },
              });
            }
          }
          return { runId, providerTurnId, events };
        };

  return { settledRun };
};

export const applyStalledRunScenario = (deps: {
  readonly orchestrator: Orchestrator.OrchestratorV2Shape;
  readonly sink: EventSink.EventSinkV2Shape;
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly stalledRun: "missing-session-terminal" | "returned-interrupt" | "superseded-attempt";
  readonly first: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly codexTurn: OrchestrationV2ThreadProjection["providerTurns"][number];
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly devServerId: TurnItemId;
  readonly watch: (
    predicate: (event: OrchestrationV2DomainEvent) => boolean,
  ) => Effect.Effect<Fiber.Fiber<void, never>, never, Scope.Scope>;
  readonly worker: EffectWorker.OrchestrationEffectWorkerV2Shape;
}) =>
  Effect.gen(function* () {
    const {
      orchestrator, sink, threadId, now, stalledRun, first, codexTurn,
      events, devServerId, watch, worker,
    } = deps;
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const node = before.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const attempt = before.attempts[0]!;
          if (stalledRun === "missing-session-terminal") {
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const failed = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* sessions.release({
              providerSessionId: first.providerThread.providerSessionId!,
              reason: "runtime_error",
            });
            yield* Fiber.join(failed).pipe(Effect.orDie);
            yield* sink.write({
              events: [
                {
                  id: EventId.make("stale-run"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: run,
                },
                {
                  id: EventId.make("stale-node"),
                  type: "node.updated",
                  threadId,
                  occurredAt: now,
                  payload: node,
                },
                {
                  id: EventId.make("stale-attempt"),
                  type: "run-attempt.updated",
                  threadId,
                  occurredAt: now,
                  payload: attempt,
                },
              ],
            });
          }
          const messageId = MessageId.make("partial-output");
          const item = before.turnItems.find((candidate) => candidate.id === devServerId)!;
          assert.ok(item.type === "command_execution");
          const terminalProviderTurn = stalledRun.endsWith("-terminal");
          if (terminalProviderTurn) {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("terminal-provider-turn"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...codexTurn, status: "completed", completedAt: now },
                },
                ...(stalledRun === "missing-session-terminal"
                  ? [
                      {
                        id: EventId.make("completed-dev-server"),
                        type: "turn-item.updated" as const,
                        threadId,
                        occurredAt: now,
                        payload: { ...item, status: "completed" as const, completedAt: now },
                      },
                    ]
                  : []),
              ],
            });
          }
          yield* sink.write({
            events: [
              {
                id: EventId.make("partial-message"),
                type: "message.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: run.id,
                  nodeId: node.id,
                  role: "assistant",
                  text: "Partial output",
                  attachments: [],
                  streaming: true,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("partial-item"),
                type: "turn-item.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...item,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                  id: TurnItemId.make("partial-output"),
                  type: "assistant_message",
                  messageId,
                  text: "Partial output",
                  streaming: true,
                },
              },
            ],
          });
          if (stalledRun === "superseded-attempt") {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("new-attempt"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...run, activeAttemptId: RunAttemptId.make("new-attempt") },
                },
              ],
            });
          }
          yield* orchestrator.dispatch(
            stalledRun === "superseded-attempt"
              ? {
                  type: "thread.background-work.settle",
                  commandId: CommandId.make("late-settle"),
                  threadId,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                }
              : {
                  type: "thread.stop",
                  commandId: CommandId.make("stop-stalled-run"),
                  threadId,
                },
          );
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          const interrupted = stalledRun !== "superseded-attempt";
          assert.equal(after.runs[0]?.status, interrupted ? "interrupted" : "running");
          assert.equal(after.attempts[0]?.status, interrupted ? "interrupted" : "running");
          assert.equal(
            after.providerTurns[0]?.status,
            terminalProviderTurn ? "completed" : interrupted ? "interrupted" : "running",
          );
          assert.equal(
            after.nodes.find((candidate) => candidate.id === node.id)?.status,
            interrupted ? "interrupted" : "running",
          );
          const output = after.messages.find((message) => message.id === messageId)!;
          assert.equal(output.streaming, !interrupted);
          assert.equal(output.text, "Partial output");
          assert.equal(
            after.turnItems.find((candidate) => candidate.id === devServerId)?.status,
            stalledRun === "missing-session-terminal"
              ? "completed"
              : interrupted
                ? "interrupted"
                : "running",
          );
          assert.equal(
            after.turnItems.find((candidate) => candidate.type === "assistant_message")?.status,
            interrupted ? "interrupted" : "running",
          );
          assert.equal(
            after.turnItems.filter((candidate) => candidate.type === "run_interrupt_result").length,
            interrupted ? 1 : 0,
          );
          assert.isEmpty(after.runs.filter((candidate) => candidate.status === "waiting"));
  });
