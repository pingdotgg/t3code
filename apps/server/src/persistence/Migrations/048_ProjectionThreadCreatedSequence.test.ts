import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeSqliteClient.layerMemory())("048_ProjectionThreadCreatedSequence", (it) => {
  it.effect(
    "repairs rollback ordering without changing timestamps or matching a deleted incarnation",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 47 });
        const before = "2026-09-01T12:00:00.000Z";
        const after = "2026-09-01T01:00:00.000Z";
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at,
          latest_user_message_at, pending_user_input_count, has_actionable_proposed_plan)
        VALUES ('thread', 'project', 'clock rollback', '{"instanceId":"codex","model":"gpt-5"}',
          ${before}, ${after}, ${before}, 1, 1)`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('first', 'thread', NULL, 'user', 'first', 0, ${before}, ${before}),
          ('second', 'thread', NULL, 'user', 'second', 0, ${after}, ${after}),
          ('import:history', 'thread', NULL, 'user', 'history', 0, ${before}, ${before}),
          ('orphan', 'thread', NULL, 'assistant', 'no retained event', 0, ${after}, ${after})`;
        yield* sql`INSERT INTO projection_thread_proposed_plans
        (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at)
        VALUES ('plan', 'thread', NULL, 'updated plan', ${before}, ${before}, NULL),
          ('later-plan', 'thread', NULL, 'implemented plan', ${after}, ${after}, ${after})`;
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('request', 'thread', NULL, 'info', 'user-input.requested', 'question',
          '{"requestId":"request"}', 100, ${before}),
          ('resolve', 'thread', NULL, 'info', 'user-input.resolved', 'answer',
          '{"requestId":"request"}', 1, ${after})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('thread', 'first-turn', 'first', 'completed', ${before}, '[]'),
          ('thread', 'second-turn', 'second', 'running', ${after}, '[]'),
          ('thread', 'autonomous', NULL, 'completed', ${after}, '[]'),
          ('thread', NULL, 'missing-prompt', 'pending', ${after}, '[]')`;

        const events = [
          ["thread.created", {}],
          ["thread.message-sent", { messageId: "first", role: "user" }],
          ["thread.deleted", {}],
          ["thread.created", {}],
          ["thread.message-sent", { messageId: "first", role: "user" }],
          ["thread.message-sent", { messageId: "second", role: "user" }],
          ["thread.message-sent", { messageId: "second", role: "user" }],
          ["thread.message-sent", { messageId: "import:history", role: "user" }],
          ["thread.proposed-plan-upserted", { proposedPlan: { id: "plan" } }],
          ["thread.proposed-plan-upserted", { proposedPlan: { id: "plan" } }],
          ["thread.activity-appended", { activity: { id: "request" } }],
          ["thread.activity-appended", { activity: { id: "resolve" } }],
          ["thread.session-set", { session: { activeTurnId: "autonomous", status: "running" } }],
          ["thread.turn-diff-completed", { turnId: "autonomous" }],
          ["thread.turn-start-requested", { messageId: "missing-prompt" }],
          ["thread.proposed-plan-upserted", { proposedPlan: { id: "later-plan" } }],
        ] as const;
        for (const [index, [type, payload]] of events.entries()) {
          yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${index}`}, 'thread', 'thread', ${index + 1}, ${type}, ${after},
            ${`command-${index}`}, 'client', ${encodePayload(payload)}, '{}')`;
        }

        yield* runMigrations({ toMigrationInclusive: 48 });
        assert.deepEqual(
          yield* sql`SELECT message_id, created_sequence, created_at
        FROM projection_thread_messages ORDER BY message_id`,
          [
            { message_id: "first", created_sequence: 5, created_at: before },
            { message_id: "import:history", created_sequence: 8, created_at: before },
            { message_id: "orphan", created_sequence: null, created_at: after },
            { message_id: "second", created_sequence: 6, created_at: after },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT created_sequence FROM projection_thread_proposed_plans ORDER BY created_sequence`,
          [{ created_sequence: 9 }, { created_sequence: 16 }],
        );
        assert.deepEqual(
          yield* sql`SELECT created_sequence, sequence FROM projection_thread_activities
        ORDER BY created_sequence`,
          [
            { created_sequence: 11, sequence: 100 },
            { created_sequence: 12, sequence: 1 },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT turn_id, created_sequence FROM projection_turns
        ORDER BY created_sequence`,
          [
            { turn_id: "first-turn", created_sequence: 5 },
            { turn_id: "second-turn", created_sequence: 6 },
            { turn_id: "autonomous", created_sequence: 13 },
            { turn_id: null, created_sequence: 15 },
          ],
        );
        assert.deepEqual(
          yield* sql`SELECT latest_user_message_at, pending_user_input_count, has_actionable_proposed_plan
        FROM projection_threads`,
          [
            {
              latest_user_message_at: after,
              pending_user_input_count: 0,
              has_actionable_proposed_plan: 0,
            },
          ],
        );
      }),
  );
});
