import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-cleanup-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const CLEANUP_PROJECTOR = "projection.attachment-cleanup";

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return (yield* Effect.result(fileSystem.stat(filePath)))._tag === "Success";
  });

it.layer(TestLayer)("OrchestrationProjectionPipeline attachment cleanup bootstrap", (it) => {
  it.effect(
    "advances the cleanup cursor to the latest event, dedupes reverts, and holds on failure",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const projectionState = yield* ProjectionStateRepository;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const now = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make("project-cleanup");
        const revertedThreadId = ThreadId.make("thread-cleanup-revert");
        const deletedThreadId = ThreadId.make("thread-cleanup-delete");
        const revertedAttachmentPath = path.join(
          attachmentsDir,
          "thread-cleanup-revert-00000000-0000-4000-8000-000000000001.png",
        );
        const deletedAttachmentPath = path.join(
          attachmentsDir,
          "thread-cleanup-delete-00000000-0000-4000-8000-000000000001.png",
        );
        const cleanupCursor = projectionState
          .listAll()
          .pipe(
            Effect.map(
              (states) =>
                states.find((state) => state.projector === CLEANUP_PROJECTOR)?.lastAppliedSequence,
            ),
          );

        let eventOrdinal = 0;
        const append = (
          event: Pick<OrchestrationEvent, "type" | "aggregateKind" | "aggregateId" | "payload">,
        ) => {
          eventOrdinal += 1;
          return eventStore.append({
            ...event,
            eventId: EventId.make(`evt-cleanup-${eventOrdinal}`),
            occurredAt: now,
            commandId: CommandId.make(`cmd-cleanup-${eventOrdinal}`),
            causationEventId: null,
            correlationId: CommandId.make(`cmd-cleanup-${eventOrdinal}`),
            metadata: {},
          } as Omit<OrchestrationEvent, "sequence">);
        };
        const appendThreadCreated = (threadId: ThreadId) =>
          append({
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: threadId,
            payload: {
              threadId,
              projectId,
              title: "Cleanup thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          });
        const appendReverted = (turnCount: number) =>
          append({
            type: "thread.reverted",
            aggregateKind: "thread",
            aggregateId: revertedThreadId,
            payload: { threadId: revertedThreadId, turnCount },
          });

        yield* append({
          type: "project.created",
          aggregateKind: "project",
          aggregateId: projectId,
          payload: {
            projectId,
            title: "Cleanup project",
            workspaceRoot: "/tmp/project-cleanup",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* appendThreadCreated(revertedThreadId);
        yield* appendThreadCreated(deletedThreadId);
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(revertedAttachmentPath, "stale");
        // Two reverts for one thread dedupe into a single prune.
        yield* appendReverted(2);
        yield* appendReverted(1);
        // The latest event is neither a revert nor a delete, yet the cursor must land on it.
        const latest = yield* append({
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: deletedThreadId,
          payload: { threadId: deletedThreadId, archivedAt: now, updatedAt: now },
        });

        yield* projectionPipeline.bootstrap;
        assert.isFalse(yield* exists(revertedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence);

        // A cleanup that cannot remove its files leaves the cursor behind for the next bootstrap.
        yield* fileSystem.makeDirectory(deletedAttachmentPath);
        yield* fileSystem.writeFileString(path.join(deletedAttachmentPath, "keep.txt"), "keep");
        yield* append({
          type: "thread.deleted",
          aggregateKind: "thread",
          aggregateId: deletedThreadId,
          payload: { threadId: deletedThreadId, deletedAt: now },
        });
        yield* projectionPipeline.bootstrap;
        assert.isTrue(yield* exists(deletedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence);

        yield* fileSystem.remove(deletedAttachmentPath, { recursive: true });
        yield* fileSystem.writeFileString(deletedAttachmentPath, "retry");
        yield* projectionPipeline.bootstrap;
        assert.isFalse(yield* exists(deletedAttachmentPath));
        assert.equal(yield* cleanupCursor, latest.sequence + 1);
      }),
  );
});
