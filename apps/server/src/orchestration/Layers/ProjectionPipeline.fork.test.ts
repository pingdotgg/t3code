import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-fork-test-" }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("OrchestrationProjectionPipeline fork projection", (it) => {
  it.effect("persists fork lineage and side-chat promotion", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-03T12:00:00.000Z";
      const threadId = ThreadId.make("thread-fork-projection");

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.make("event-fork-projection-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("command-fork-projection-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-fork-projection-created"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-fork-projection"),
          title: "Side chat: Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          fork: {
            sourceThreadId: ThreadId.make("thread-source-projection"),
            sourceTurnId: TurnId.make("turn-source-projection"),
            sourceMessageId: null,
            forkedAt: now,
          },
          sideChat: true,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{ readonly forkJson: string | null; readonly sideChat: number }>`
        SELECT fork_json AS "forkJson", side_chat AS "sideChat"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rows, [
        {
          forkJson:
            '{"sourceThreadId":"thread-source-projection","sourceTurnId":"turn-source-projection","sourceMessageId":null,"forkedAt":"2026-09-03T12:00:00.000Z"}',
          sideChat: 1,
        },
      ]);

      yield* eventStore.append({
        type: "thread.meta-updated",
        eventId: EventId.make("event-fork-projection-promoted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make("command-fork-projection-promoted"),
        causationEventId: null,
        correlationId: CommandId.make("command-fork-projection-promoted"),
        metadata: {},
        payload: { threadId, sideChat: false, updatedAt: now },
      });
      yield* projectionPipeline.bootstrap;
      // Promotion clears the side-chat flag but must leave the lineage intact.
      const promotedRows = yield* sql<{
        readonly sourceThreadId: string | null;
        readonly sourceTurnId: string | null;
        readonly sourceMessageId: string | null;
        readonly forkedAt: string | null;
        readonly sideChat: number;
      }>`
        SELECT
          json_extract(fork_json, '$.sourceThreadId') AS "sourceThreadId",
          json_extract(fork_json, '$.sourceTurnId') AS "sourceTurnId",
          json_extract(fork_json, '$.sourceMessageId') AS "sourceMessageId",
          json_extract(fork_json, '$.forkedAt') AS "forkedAt",
          side_chat AS "sideChat"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(promotedRows, [
        {
          sourceThreadId: "thread-source-projection",
          sourceTurnId: "turn-source-projection",
          sourceMessageId: null,
          forkedAt: now,
          sideChat: 0,
        },
      ]);
    }),
  );
});
