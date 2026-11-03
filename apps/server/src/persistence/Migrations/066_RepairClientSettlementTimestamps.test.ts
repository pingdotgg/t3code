import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../Migrations.ts";
import Migration0066 from "./066_RepairClientSettlementTimestamps.ts";

const layer = it.layer(
  ProjectionMaintenance.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
const createdAt = "2026-03-01T00:00:00.000Z";
const sweptAt = "2026-09-04T13:33:00.000Z";
const userMessageAt = "2026-04-01T00:00:00.000Z";
const finishedAt = "2026-06-01T00:05:00.000Z";
const manualAt = "2026-10-01T00:00:00.000Z";
const plusSeconds = (iso: string, seconds: number) =>
  DateTime.makeUnsafe(iso).pipe(DateTime.add({ seconds }), DateTime.formatIso);

layer("066_RepairClientSettlementTimestamps", (it) => {
  it.effect("repairs only sweep stamps, preserves overrides, and survives a V2 rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_turns'`,
        [],
      );
      let eventNumber = 0;
      const insertEvent = (
        threadId: string,
        eventType: string,
        occurredAt: string,
        payload: Record<string, unknown>,
        applicationVersion = 1,
        actor = "client",
        appVersion: string | null = "0.0.37",
      ) => {
        const version = eventNumber++;
        return sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${`event-${version}`}, 'thread', ${threadId}, ${version}, ${eventType}, ${occurredAt},
            ${`command-${version}`}, ${actor}, ${JSON.stringify(payload)},
            ${JSON.stringify({ origin: { appVersion } })}, ${applicationVersion}
          )
        `;
      };
      const insertSettlement = Effect.fnUntraced(function* (
        id: string,
        at: string,
        appVersion: string | null = "0.0.37",
        actor = "client",
      ) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, created_at, updated_at,
            settled_override, settled_at
          ) VALUES (
            ${id}, 'project-1', ${id}, '{"instanceId":"codex","model":"gpt-5.4"}',
            ${createdAt}, ${at}, 'settled', ${at}
          )
        `;
        yield* insertEvent(
          id,
          "thread.settled",
          at,
          { threadId: id, settledAt: at, updatedAt: at },
          1,
          actor,
          appVersion,
        );
      });

      // A finished turn must come from retained events after 063 drops projection_turns.
      for (const [at, status, activeTurnId] of [
        ["2026-06-01T00:00:00.000Z", "running", "turn-1"],
        [finishedAt, "ready", null],
        ["2026-06-03T00:00:00.000Z", "stopped", null],
      ] as const) {
        yield* insertEvent(
          "sweep-2",
          "thread.session-set",
          at,
          {
            threadId: "sweep-2",
            session: { status, activeTurnId, updatedAt: at },
          },
          1,
          "server",
        );
        if (status === "running") {
          for (let index = 0; index < 500; index++) {
            yield* insertEvent(
              "sweep-2",
              "thread.turn-start-requested",
              "invalid",
              {
                createdAt: "invalid",
              },
              1,
              "server",
            );
          }
        }
      }
      for (let index = 0; index < 10; index++) {
        yield* insertSettlement(
          `sweep-${index}`,
          plusSeconds(sweptAt, index * 2),
          `0.0.${35 + (index % 4)}`,
        );
      }
      // Completed or reverted turns must not be finished again by an idle restart.
      for (const [id, eventType, at, payload] of [
        [
          "sweep-5",
          "thread.message-sent",
          userMessageAt,
          {
            turnId: "finished",
            role: "assistant",
            streaming: true,
            createdAt: userMessageAt,
          },
        ],
        [
          "sweep-5",
          "thread.message-sent",
          finishedAt,
          {
            turnId: "finished",
            role: "assistant",
            streaming: false,
            createdAt: userMessageAt,
            updatedAt: finishedAt,
          },
        ],
        [
          "sweep-6",
          "thread.session-set",
          "invalid",
          {
            session: { status: "running", activeTurnId: "invalid-start", updatedAt: "invalid" },
          },
        ],
        [
          "sweep-6",
          "thread.session-set",
          finishedAt,
          {
            session: { status: "ready", activeTurnId: null, updatedAt: "invalid" },
          },
        ],
        [
          "sweep-7",
          "thread.session-set",
          userMessageAt,
          {
            session: { status: "running", activeTurnId: "discarded", updatedAt: userMessageAt },
          },
        ],
        ["sweep-7", "thread.reverted", finishedAt, { turnCount: 0 }],
      ] as const) {
        yield* insertEvent(id, eventType, at, payload, 1, "server");
      }
      for (const id of ["sweep-5", "sweep-6", "sweep-7"]) {
        yield* insertEvent(
          id,
          "thread.session-set",
          "2026-06-03T00:00:00.000Z",
          {
            session: {
              status: "stopped",
              activeTurnId: null,
              updatedAt: "2026-06-03T00:00:00.000Z",
            },
          },
          1,
          "server",
        );
      }
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('before', 'sweep-0', 'user', 'Prompt', 0, ${userMessageAt}, ${userMessageAt}),
          ('after', 'sweep-0', 'user', 'Later prompt', 0, ${manualAt}, ${manualAt})
      `;
      yield* insertEvent(
        "sweep-2",
        "thread.turn-start-requested",
        manualAt,
        {
          threadId: "sweep-2",
          createdAt: manualAt,
        },
        1,
        "server",
      );
      yield* sql`UPDATE projection_threads SET settled_at = ${manualAt} WHERE thread_id = 'sweep-3'`;
      yield* sql`UPDATE projection_threads SET settled_override = 'active', settled_at = NULL WHERE thread_id = 'sweep-4'`;

      // This manual settle is within two minutes, but outside the sweep's 30-second gap.
      yield* insertSettlement("manual", plusSeconds(sweptAt, 18 + 45));
      // Ten events for nine distinct threads must not qualify.
      for (let index = 0; index < 9; index++) {
        yield* insertSettlement(
          `small-${index}`,
          plusSeconds("2026-09-03T00:00:00.000Z", index * 2),
        );
      }
      const repeatedAt = "2026-09-03T00:00:18.000Z";
      yield* insertEvent("small-8", "thread.settled", repeatedAt, { settledAt: repeatedAt });
      yield* sql`UPDATE projection_threads SET settled_at = ${repeatedAt} WHERE thread_id = 'small-8'`;
      for (let index = 0; index < 10; index++) {
        yield* insertSettlement(
          `spread-${index}`,
          plusSeconds("2026-09-03T01:00:00.000Z", index * 15),
        );
        yield* insertSettlement(
          `late-${index}`,
          plusSeconds("2026-09-05T00:00:00.000Z", index * 2),
        );
      }
      yield* insertSettlement("wrong-version", sweptAt, "0.0.40");
      yield* insertSettlement("missing-version", sweptAt, null);
      yield* insertSettlement("server", sweptAt, "0.0.37", "server");
      yield* insertSettlement("different-stamp", sweptAt);
      yield* sql`
        UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.settledAt', ${createdAt})
        WHERE stream_id = 'different-stamp'
      `;
      const untouched = sql`
        SELECT * FROM projection_threads WHERE thread_id NOT LIKE 'sweep-%' ORDER BY thread_id
      `;
      const untouchedBefore = yield* untouched;

      for (const index of [0, 2, 3, 4]) {
        const id = `sweep-${index}`;
        const badStamp = plusSeconds(sweptAt, index * 2);
        const thread = {
          id,
          projectId: "project-1",
          title: id,
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
          forkedFrom: null,
          createdAt,
          updatedAt: badStamp,
          archivedAt: null,
          deletedAt: null,
          settledOverride: "settled",
          settledAt: badStamp,
        };
        yield* insertEvent(id, "thread.created", badStamp, thread, 2);
        const current = {
          ...thread,
          settledOverride: index === 4 ? "active" : "settled",
          settledAt: index === 4 ? null : index === 3 ? manualAt : badStamp,
        };
        if (index === 4) {
          yield* insertEvent(
            id,
            "thread.metadata-updated",
            badStamp,
            {
              ...thread,
              settledOverride: "active",
            },
            2,
          );
        }
        if (index !== 2) yield* insertEvent(id, "thread.metadata-updated", manualAt, current, 2);
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${badStamp}, ${JSON.stringify(current)}
          )
        `;
      }
      const v1History = sql`
        SELECT * FROM orchestration_events WHERE application_event_version = 1 ORDER BY sequence
      `;
      const v1Before = yield* v1History;
      const overrides = sql`
        SELECT * FROM orchestration_events
        WHERE application_event_version = 2 AND event_type = 'thread.metadata-updated'
          AND stream_id IN ('sweep-3', 'sweep-4') ORDER BY sequence
      `;
      const overridesBefore = yield* overrides;

      yield* runMigrations({ toMigrationInclusive: 66 });
      const legacy = yield* sql`
        SELECT thread_id, settled_override, settled_at FROM projection_threads
        WHERE thread_id LIKE 'sweep-%' ORDER BY thread_id
      `;
      assert.deepEqual(
        legacy,
        Array.from({ length: 10 }, (_, index) => ({
          thread_id: `sweep-${index}`,
          settled_override: index === 4 ? "active" : "settled",
          settled_at:
            index === 4
              ? null
              : ([
                  userMessageAt,
                  createdAt,
                  finishedAt,
                  manualAt,
                  null,
                  finishedAt,
                  finishedAt,
                  userMessageAt,
                ][index] ?? createdAt),
        })),
      );
      assert.deepEqual(yield* untouched, untouchedBefore);
      assert.deepEqual(yield* v1History, v1Before);
      assert.deepEqual(yield* overrides, overridesBefore);
      const imported = sql`
        SELECT thread_id,
          json_extract(payload_json, '$.settledAt') AS settled_at,
          json_extract(payload_json, '$.settledOverride') AS settled_override,
          json_extract(payload_json, '$.title') AS title
        FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      const expectedImported = legacy
        .filter((_, index) => [0, 2, 3, 4].includes(index))
        .map((row) => ({ ...row, title: row.thread_id }));
      assert.deepEqual(yield* imported, expectedImported);
      const snapshot = Effect.all([
        sql`SELECT * FROM projection_threads ORDER BY thread_id`,
        sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`,
        sql`SELECT * FROM orchestration_events ORDER BY sequence`,
      ]);
      const repaired = yield* snapshot;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 66 }), []);
      yield* Migration0066;
      assert.deepEqual(yield* snapshot, repaired);

      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* imported, expectedImported);
    }),
  );
});
