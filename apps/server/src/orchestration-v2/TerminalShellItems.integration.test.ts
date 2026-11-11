import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "test-model" };
const databaseLayer = SqlitePersistence.layerMemory;
const capabilities = {
  ...ClaudeProviderCapabilitiesV2,
  sessions: {
    ...ClaudeProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsRuntimeModeSwitchInSession: false,
  },
};

it.effect.each([
  "approval",
  "dynamic approval",
  "accepted approval",
  "released approval",
  "withdrawn approval",
  "pending",
  "unlinked running",
  "approval on provider failure",
] as const)("ending a run cancels only tools that never started: %s", (check) =>
  Effect.scoped(
    Effect.gen(function* () {
      const testCapabilities =
        check === "approval on provider failure"
          ? {
              ...capabilities,
              sessions: { ...capabilities.sessions, supportsRuntimeModeSwitchInSession: true },
            }
          : capabilities;
      const cwd = yield* checkpointWorkspace("terminal-shell-items");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(testCapabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
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
                capabilities: testCapabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:claudeAgent:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:terminal-shell-items");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:terminal-shell-items"),
          title: "Terminal shell items",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        const dispatch = (id: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: "Continue",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* dispatch("first");
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        const now = yield* DateTime.now;
        const requestId = RuntimeRequestId.make("request:pending-shell");
        const commandItem = {
          id: TurnItemId.make("item:pending-shell"),
          threadId,
          runId: first.runId,
          nodeId: NodeId.make("node:command"),
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          nativeItemRef: { driver, nativeId: "shell-native", strength: "strong" as const },
          parentItemId: null,
          ordinal: 100,
          status: check === "pending" ? ("pending" as const) : ("running" as const),
          title: "Approval-blocked shell",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          ...(check === "dynamic approval"
            ? { type: "dynamic_tool" as const, toolName: "mcp:test", input: {} }
            : { type: "command_execution" as const, input: "echo approved" }),
        };
        const commandNode = {
          id: NodeId.make("node:command"),
          threadId,
          runId: first.runId,
          parentNodeId: first.rootNodeId,
          rootNodeId: first.rootNodeId,
          kind: "tool_call" as const,
          status: commandItem.status,
          countsForRun: true,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          nativeItemRef: commandItem.nativeItemRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: commandItem.completedAt,
        };
        const approvalPending = check.includes("approval");
        const ingested = yield* watch((event) =>
          approvalPending
            ? event.type === "runtime-request.updated" && event.payload.id === requestId
            : event.type === "turn-item.updated" && event.payload.id === commandItem.id,
        );
        yield* Queue.offer(events, { type: "node.updated", driver, node: commandNode });
        yield* Queue.offer(events, { type: "turn_item.updated", driver, turnItem: commandItem });
        if (approvalPending) {
          const approvalNodeId = NodeId.make("node:approval");
          yield* Queue.offer(events, {
            type: "node.updated",
            driver,
            node: {
              ...commandNode,
              id: approvalNodeId,
              parentNodeId: commandNode.id,
              kind: "approval_request",
              status: "waiting",
              runtimeRequestId: requestId,
            },
          });
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...commandItem,
              id: TurnItemId.make("item:approval"),
              nodeId: approvalNodeId,
              type: "approval_request",
              requestId,
              requestKind: "command",
              status: "waiting",
            },
          });
          yield* Queue.offer(events, {
            type: "node.updated",
            driver,
            node: {
              ...commandNode,
              id: NodeId.make("node:unrelated-approval"),
              parentNodeId: first.rootNodeId,
              kind: "approval_request",
              status: "waiting",
              runtimeRequestId: RuntimeRequestId.make("request:unrelated"),
            },
          });
          yield* Queue.offer(events, {
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: {
              id: RuntimeRequestId.make("request:unrelated"),
              nodeId: NodeId.make("node:unrelated-approval"),
              providerTurnId: turn.id,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: projection.providerSessions[0]!.id,
              },
              createdAt: now,
              resolvedAt: null,
            },
          });
          yield* Queue.offer(events, {
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: {
              id: requestId,
              nodeId: approvalNodeId,
              providerTurnId: turn.id,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: projection.providerSessions[0]!.id,
              },
              createdAt: now,
              resolvedAt: null,
            },
          });
        }
        yield* Fiber.join(ingested);
        const before = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.id === commandItem.id,
        );
        assert.ok(before);
        if (check === "accepted approval" || check === "released approval") {
          const eventSink = yield* EventSink.EventSinkV2;
          const stale = yield* orchestrator.getThreadProjection(threadId);
          const request = stale.runtimeRequests.find((candidate) => candidate.id === requestId)!;
          const approvalNode = stale.nodes.find((node) => node.id === request.nodeId)!;
          const approvalItem = stale.turnItems.find(
            (item) => item.id === TurnItemId.make("item:approval"),
          )!;
          const cancelledAt = { status: "cancelled" as const, completedAt: now };
          const staleEvent = (id: string) => ({
            id: EventId.make(`stale-${id}`),
            threadId,
            runId: first.runId,
            occurredAt: now,
          });
          if (check === "accepted approval") {
            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("approve"),
              threadId,
              requestId,
              decision: "accept",
            });
            yield* worker.drain();
          } else {
            yield* eventSink.write({
              events: [
                {
                  ...staleEvent("release-request"),
                  type: "runtime-request.updated",
                  payload: {
                    ...request,
                    status: "cancelled",
                    responseCapability: { type: "not_resumable", reason: "Session closed." },
                    resolvedAt: now,
                  },
                },
                {
                  ...staleEvent("release-node"),
                  type: "node.updated",
                  payload: { ...approvalNode, ...cancelledAt },
                },
                {
                  ...staleEvent("release-item"),
                  type: "turn-item.updated",
                  payload: { ...approvalItem, ...cancelledAt },
                },
              ],
            });
          }
          // Finalization read the approval as pending before it was answered or released.
          yield* eventSink.writeWithEffects({
            guardPendingApprovalCancellations: true,
            effects: [],
            events: [
              {
                ...staleEvent("tool"),
                type: "turn-item.updated",
                payload: { ...before, ...cancelledAt, toolNonExecutionKind: "cancelled" },
              },
              {
                ...staleEvent("tool-node"),
                type: "node.updated",
                payload: {
                  ...stale.nodes.find((node) => node.id === commandNode.id)!,
                  ...cancelledAt,
                },
              },
              {
                ...staleEvent("request"),
                type: "runtime-request.updated",
                payload: { ...request, status: "cancelled", resolvedAt: now },
              },
              {
                ...staleEvent("approval-node"),
                type: "node.updated",
                payload: { ...approvalNode, ...cancelledAt },
              },
              {
                ...staleEvent("approval-item"),
                type: "turn-item.updated",
                payload: { ...approvalItem, ...cancelledAt },
              },
            ],
          });
          if (check === "released approval") {
            const released = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              released.turnItems.find((item) => item.id === commandItem.id)?.status,
              "cancelled",
            );
            assert.deepEqual(
              released.runtimeRequests.find((candidate) => candidate.id === requestId)
                ?.responseCapability,
              { type: "not_resumable", reason: "Session closed." },
            );
          }
        }
        if (check === "withdrawn approval") {
          // Claude withdraws the prompt when a PermissionRequest hook allows the tool, which then runs.
          const withdrawn = yield* watch(
            (event) =>
              event.type === "runtime-request.updated" &&
              event.payload.id === requestId &&
              event.payload.status === "cancelled",
          );
          const request = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
            (candidate) => candidate.id === requestId,
          )!;
          yield* Queue.offer(events, {
            type: "runtime_request.updated",
            driver,
            threadId,
            runtimeRequest: { ...request, status: "cancelled", resolvedAt: now },
          });
          yield* Fiber.join(withdrawn);
        }
        const failed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "failed",
        );
        if (check === "approval on provider failure") {
          // The session stays live, so only the run's own finalization can close the approval.
          yield* Queue.offerAll(events, [
            {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "failed", completedAt: now },
            },
            {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status: "failed",
              failureItemOrdinal: 200,
              failure: {
                class: "provider_error",
                message: "Query closed",
                code: null,
                retryable: null,
              },
              threadDisposition: "reusable",
            },
          ]);
        } else {
          // Claude cannot switch modes in session, so this detaches it and fails the run.
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("change-mode"),
            threadId,
            runtimeMode: "auto",
          });
        }
        yield* worker.drain();
        yield* Fiber.join(failed);
        // Read before the next run hides background tasks behind its active status.
        const shell = (yield* projections.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const pending = shell.pendingBackgroundTasks ?? [];
        yield* dispatch("second");
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        const item = after.turnItems.find((candidate) => candidate.id === commandItem.id)!;
        if (
          check === "accepted approval" ||
          check === "withdrawn approval" ||
          check === "unlinked running"
        ) {
          assert.deepEqual(item, before);
          assert.isTrue(pending.some((task) => task.taskId === "shell-native"));
          if (check === "accepted approval") {
            assert.equal(
              after.runtimeRequests.find((request) => request.id === requestId)?.status,
              "resolved",
            );
            assert.equal(
              after.turnItems.find((candidate) => candidate.id === TurnItemId.make("item:approval"))
                ?.status,
              "completed",
            );
          }
          return;
        }
        assert.equal(item.status, "cancelled");
        assert.equal(item.toolNonExecutionKind, "cancelled");
        assert.isNotNull(item.completedAt);
        assert.equal(after.nodes.find((node) => node.id === commandNode.id)?.status, "cancelled");
        assert.isFalse(pending.some((task) => task.taskId === "shell-native"));
        const lateEvent: OrchestrationV2DomainEvent = {
          id: EventId.make("late-tool-use"),
          type: "turn-item.updated",
          threadId,
          runId: first.runId,
          occurredAt: now,
          payload: commandItem,
        };
        assert.deepEqual(
          ProjectionStore.applyToProjection(after, lateEvent).turnItems.find(
            (candidate) => candidate.id === item.id,
          ),
          item,
        );
        yield* projections.apply(lateEvent);
        assert.deepEqual(yield* projections.getTurnItem({ threadId, itemId: item.id }), item);
        if (!approvalPending) return;
        const request = after.runtimeRequests.find((candidate) => candidate.id === requestId)!;
        assert.notEqual(request.status, "pending");
        assert.equal(request.responseCapability.type, "not_resumable");
        assert.equal(after.nodes.find((node) => node.id === request.nodeId)?.status, "cancelled");
        assert.equal(
          after.turnItems.find((candidate) => candidate.id === TurnItemId.make("item:approval"))
            ?.status,
          "cancelled",
        );
        const response = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("late-approve"),
            threadId,
            requestId,
            decision: "accept",
          })
          .pipe(Effect.flip);
        assert.equal(response._tag, "OrchestratorDispatchError");
        if (check === "approval on provider failure") {
          const unrelated = after.runtimeRequests.find(
            (candidate) => candidate.id === RuntimeRequestId.make("request:unrelated"),
          )!;
          assert.equal(unrelated.status, "pending");
          assert.equal(unrelated.responseCapability.type, "live");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProviderReplayHarness.layerWithRegistry(
              { name: "terminal-shell-items" },
              ProviderAdapterRegistry.layerFromAdapters([adapter]),
              { runEffectWorker: false, databaseLayer },
            ),
            ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
          ),
        ),
      );
    }),
  ),
);
