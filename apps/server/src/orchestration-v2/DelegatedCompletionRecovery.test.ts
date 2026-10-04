import { it, assert } from "@effect/vitest";
import {
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

it.effect.each([
  { oldFollowup: false, tracked: false, stopped: false, active: false },
  { oldFollowup: true, tracked: false, stopped: false, active: false },
  { oldFollowup: true, tracked: true, stopped: false, active: false },
  { oldFollowup: true, tracked: true, stopped: true, active: false },
  { oldFollowup: true, tracked: true, stopped: false, active: true },
  { oldFollowup: false, tracked: true, stopped: false, active: true },
])(
  "startup backfills historical results without waking parents, %s",
  ({ oldFollowup, tracked, stopped, active }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const databaseContext = yield* Layer.build(SqlitePersistenceMemory);
        const databaseLayer = Layer.succeedContext(databaseContext);
        const storeContext = yield* Layer.build(
          ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
        );
        const store = yield* Effect.service(ProjectionStore.ProjectionStoreV2).pipe(
          Effect.provide(storeContext),
        );
        const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
        const parentId = ThreadId.make("review:startup:parent");
        const childId = ThreadId.make("review:startup:child");
        const providerId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId: providerId, model: "gpt-5.4" };
        const taskId = NodeId.make("review:startup:task");
        const parentRunId = RunId.make("review:startup:parent-run");
        const providerThreadId = ProviderThreadId.make("review:startup:provider-thread");
        const root = NodeId.make("review:startup:root");
        for (const id of [parentId, childId]) {
          yield* store.apply({
            id: EventId.make(`review:startup:thread:${id}`),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: {
              id,
              projectId: ProjectId.make("review:startup:project"),
              title: "Settled historical work",
              providerInstanceId: providerId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              createdBy: "user",
              creationSource: "web",
              lineage: {
                parentThreadId: id === childId ? parentId : null,
                rootThreadId: parentId,
                relationshipToParent: id === childId ? "subagent" : null,
              },
              forkedFrom: id === childId ? { type: "node", nodeId: taskId } : null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              deletedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
            },
          });
        }
        yield* store.apply({
          id: EventId.make("review:startup:provider-thread"),
          type: "provider-thread.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: providerId,
            providerSessionId: null,
            appThreadId: parentId,
            ownerNodeId: root,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "old-parent",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        const run = (threadId: ThreadId, id: RunId, ordinal: number) => ({
          id,
          threadId,
          ordinal,
          providerInstanceId: providerId,
          modelSelection,
          providerThreadId: threadId === parentId ? providerThreadId : null,
          userMessageId: MessageId.make(`review:startup:user:${id}`),
          rootNodeId: root,
          activeAttemptId: null,
          status: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        });
        yield* store.apply({
          id: EventId.make("review:startup:parent-run"),
          type: "run.updated",
          threadId: parentId,
          runId: parentRunId,
          occurredAt: now,
          payload: {
            ...run(parentId, parentRunId, 1),
            delegatedCompletion: {
              disposition: stopped ? "stopped" : "open",
              nextGeneration: 2,
              delivery: null,
            },
          },
        });
        yield* store.apply({
          id: EventId.make("review:startup:task"),
          type: "subagent.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: taskId,
            threadId: parentId,
            runId: parentRunId,
            parentNodeId: root,
            origin: "app_owned",
            createdBy: "agent",
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: providerId,
            providerThreadId: null,
            childThreadId: childId,
            nativeTaskRef: null,
            prompt: "Old work",
            title: null,
            model: null,
            completionWake: "always",
            completionDelivery: {
              state: active ? "pending" : "acknowledged",
              observedByRunId: active ? null : parentRunId,
            },
            status: active ? "running" : "completed",
            result: active ? null : "Old success",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
        const originalId = RunId.make("review:startup:original");
        for (let ordinal = 1; ordinal <= (oldFollowup ? 2 : 1); ordinal++) {
          const id = ordinal === 1 ? originalId : RunId.make("review:startup:old-followup");
          yield* store.apply({
            id: EventId.make(`review:startup:run:${ordinal}`),
            type: "run.updated",
            threadId: childId,
            runId: id,
            occurredAt: now,
            payload: {
              ...run(childId, id, ordinal),
              ...(tracked && ordinal > 1 ? { delegatedTaskParentRunId: parentRunId } : {}),
            },
          });
          yield* store.apply({
            id: EventId.make(`review:startup:message:${ordinal}`),
            type: "message.updated",
            threadId: childId,
            runId: id,
            occurredAt: now,
            payload: {
              id: MessageId.make(`review:startup:message:${ordinal}`),
              threadId: childId,
              runId: id,
              nodeId: null,
              role: "assistant",
              text: "Old completed result",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        if (active) {
          const id = RunId.make("review:startup:active-followup");
          yield* store.apply({
            id: EventId.make("review:startup:active-run"),
            type: "run.updated",
            threadId: childId,
            runId: id,
            occurredAt: now,
            payload: {
              ...run(childId, id, oldFollowup ? 3 : 2),
              delegatedTaskParentRunId: parentRunId,
              status: "running",
              completedAt: null,
            },
          });
        }
        if (!active || oldFollowup)
          yield* store.apply({
            id: EventId.make("review:startup:transfer"),
            type: "context-transfer.created",
            threadId: parentId,
            occurredAt: now,
            payload: {
              id: ContextTransferId.make("review:startup:transfer"),
              type: "subagent_result",
              sourceThreadId: childId,
              targetThreadId: parentId,
              sourcePoint: { threadId: childId, runId: originalId },
              basePoint: null,
              sourceProviderInstanceId: providerId,
              targetProviderInstanceId: providerId,
              targetRunId: parentRunId,
              status: "consumed",
              resolution: null,
              createdBy: "system",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          });
        const offers = yield* Ref.make<
          ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
        >([]);
        const registry = Layer.merge(
          ProviderAdapterRegistry.makeLayer([]),
          Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: (request) => Ref.update(offers, (existing) => [...existing, request]),
            take: Effect.never,
          }),
        );
        const layer = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "review-startup" },
          registry,
          { databaseLayer, runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.recoverDelegatedTasks;
          const parent = yield* orchestrator.getThreadProjection(parentId);
          assert.equal(
            parent.subagents[0]?.completionDelivery?.state,
            active ? "pending" : tracked ? (stopped ? "disposed" : "claimed") : "acknowledged",
          );
          if (active) {
            assert.equal(parent.subagents[0]?.status, "running");
            assert.isNull(parent.subagents[0]?.result);
          }
          const offered = yield* Ref.get(offers);
          if (tracked && !stopped && !active) assert.isAbove(offered.length, 0);
          else assert.lengthOf(offered, 0);
          assert.lengthOf(parent.contextTransfers, oldFollowup ? 2 : 1);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
