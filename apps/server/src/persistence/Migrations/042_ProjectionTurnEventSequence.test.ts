import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Option from "effect/Option";
import { MessageId, ThreadId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionTurnRepositoryLive } from "../Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionTurnEventSequence", (it) => {
  it.effect("leaves legacy pending rows uncorrelated and permits ordered new rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-before-pending-rollout', 'thread', 'thread-legacy-pending', 0,
          'thread.turn-start-requested', '2026-08-13T00:00:00.000Z',
          'command-before-pending-rollout', NULL, 'command-before-pending-rollout',
          'client',
          '{"threadId":"thread-legacy-pending","messageId":"message-legacy","runtimeMode":"full-access","createdAt":"2026-08-13T00:00:00.000Z"}',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        ) VALUES (
          'thread-legacy-pending', NULL, 'message-legacy', NULL, 'pending',
          '2026-08-13T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      assert.deepEqual(
        yield* sql<{ readonly eventSequence: number | null }>`
          SELECT event_sequence AS "eventSequence"
          FROM projection_turns
          WHERE thread_id = 'thread-legacy-pending'
        `,
        [{ eventSequence: null }],
      );
      const legacyLookup = yield* Effect.gen(function* () {
        const turns = yield* ProjectionTurnRepository;
        const threadId = ThreadId.make("thread-legacy-pending");
        yield* turns.appendPendingTurnStart({
          eventSequence: 1,
          threadId,
          messageId: MessageId.make("message-historical-rebuild"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: "2026-08-13T00:00:00.000Z",
        });
        return yield* turns.getPendingTurnStartByThreadId({ threadId });
      }).pipe(Effect.provide(ProjectionTurnRepositoryLive));
      assert.isTrue(Option.isNone(legacyLookup));
      yield* Effect.gen(function* () {
        const turns = yield* ProjectionTurnRepository;
        const threadId = ThreadId.make("thread-legacy-pending");
        yield* turns.appendPendingTurnStart({
          eventSequence: 2,
          threadId,
          messageId: MessageId.make("message-new-one"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: "2026-08-13T00:00:01.000Z",
        });
        yield* turns.appendPendingTurnStart({
          eventSequence: 3,
          threadId,
          messageId: MessageId.make("message-new-two"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: "2026-08-13T00:00:02.000Z",
        });
      }).pipe(Effect.provide(ProjectionTurnRepositoryLive));
      assert.deepEqual(
        yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = 'thread-legacy-pending'
            AND event_sequence IS NOT NULL
          ORDER BY event_sequence ASC
        `,
        [{ messageId: "message-new-one" }, { messageId: "message-new-two" }],
      );
    }),
  );
});
