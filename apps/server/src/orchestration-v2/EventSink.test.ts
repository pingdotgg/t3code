import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(Sqlite.layerMemory),
);

it.effect.each([false, true])(
  "checks fork source lifetime inside the commit transaction, deleted before commit=%s",
  (deleteFirst) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const sourceId = ThreadId.make("fork-source");
      const targetId = ThreadId.make("fork-target");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const source: OrchestrationV2AppThread = {
        id: sourceId,
        projectId: ProjectId.make("project"),
        title: "Source",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { rootThreadId: sourceId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("source-created"),
            type: "thread.created",
            threadId: sourceId,
            occurredAt: now,
            payload: source,
          },
        ],
      });
      const plannedFork = {
        commandId: CommandId.make("fork"),
        commandType: "thread.fork",
        threadId: targetId,
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: EventId.make("fork-created"),
            type: "thread.created" as const,
            threadId: targetId,
            occurredAt: now,
            payload: {
              ...source,
              id: targetId,
              forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
            },
          },
        ],
      };
      const deleteSource = sink.write({
        events: [
          {
            id: EventId.make("source-deleted"),
            type: "thread.deleted",
            threadId: sourceId,
            occurredAt: now,
            payload: { ...source, deletedAt: now },
          },
        ],
      });
      if (deleteFirst) {
        yield* deleteSource;
        const rejected = yield* sink.commitCommand(plannedFork);
        assert.equal(rejected.receipt.status, "rejected");
        assert.equal(rejected.receipt.error, "Cannot fork a missing or deleted thread.");
        assert.isFalse(rejected.committed);
        assert.deepEqual(rejected.storedEvents, []);
        const replayed = yield* sink.commitCommand(plannedFork);
        assert.deepEqual(replayed.receipt, rejected.receipt);
        assert.isFalse(replayed.committed);
        assert.deepEqual(replayed.storedEvents, []);
        const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
        assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
      } else {
        assert.isTrue((yield* sink.commitCommand(plannedFork)).committed);
        yield* deleteSource;
        // A receipt replay must still return the fork that committed before deletion.
        assert.isFalse((yield* sink.commitCommand(plannedFork)).committed);
        assert.deepEqual(
          (yield* projections.getThread(targetId)).forkedFrom,
          plannedFork.events[0]!.payload.forkedFrom,
        );
      }
    }).pipe(Effect.provide(layer)),
);
