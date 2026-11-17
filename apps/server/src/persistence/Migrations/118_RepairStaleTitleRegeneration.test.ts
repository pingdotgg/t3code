import { assert, it } from "@effect/vitest";
import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-10-05T08:45:02.809Z";
const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

layer("118_RepairStaleTitleRegeneration", (it) => {
  it.effect("clears title markers that no pending or running title job will complete", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 117 });

      const insertThread = (id: string, titleRegeneration: unknown, parentThreadId?: string) => {
        const payload = {
          id,
          projectId: "project-1",
          title: id,
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: parentThreadId === undefined ? "user" : "agent",
          creationSource: "web",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: parentThreadId ?? null,
            relationshipToParent: parentThreadId === undefined ? null : "subagent",
            rootThreadId: parentThreadId ?? id,
          },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          deletedAt: null,
          titleRegeneration,
        };
        return sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${JSON.stringify(payload)}
          )
        `;
      };
      const insertTitleJob = (threadId: string, commandId: string, status: string) =>
        sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            available_at, created_at, updated_at
          ) VALUES (
            ${`effect:${commandId}:${threadId}`}, ${commandId}, ${threadId},
            'thread-title.generate', '{}', ${status}, ${createdAt}, ${createdAt}, ${createdAt}
          )
        `;
      const marker = (requestId: string) => ({ requestId, startedAt: createdAt });

      // A subagent copied its parent's marker, and only the parent had a title job.
      yield* insertThread("parent", null);
      yield* insertTitleJob("parent", "parent:initial-message", "succeeded");
      yield* insertThread("subagent", marker("parent:initial-message"), "parent");
      // A subagent whose parent's title job is still queued has no job of its own either.
      yield* insertThread("queued-parent", marker("queued:initial-message"));
      yield* insertTitleJob("queued-parent", "queued:initial-message", "pending");
      yield* insertThread("queued-subagent", marker("queued:initial-message"), "queued-parent");
      // Jobs that finished without clearing the marker will not run again.
      yield* insertThread("failed-job", marker("failed:regenerate"));
      yield* insertTitleJob("failed-job", "failed:regenerate", "failed");
      yield* insertThread("cancelled-job", marker("cancelled:regenerate"));
      yield* insertTitleJob("cancelled-job", "cancelled:regenerate", "cancelled");
      // A live job for an older request cannot clear a newer marker.
      yield* insertThread("superseded-job", marker("new:regenerate"));
      yield* insertTitleJob("superseded-job", "old:regenerate", "running");
      // Live jobs still complete their own marker.
      yield* insertThread("running-job", marker("running:regenerate"));
      yield* insertTitleJob("running-job", "running:regenerate", "running");
      yield* insertThread("absent", undefined);

      const rows = sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id
      `;
      const before = new Map((yield* rows).map((row) => [row.thread_id, row.payload_json]));

      yield* runMigrations({ toMigrationInclusive: 118 });
      const after = new Map((yield* rows).map((row) => [row.thread_id, row.payload_json]));
      for (const id of ["parent", "queued-parent", "running-job", "absent"]) {
        assert.strictEqual(after.get(id), before.get(id));
      }
      const markers = yield* sql`
        SELECT thread_id, json_type(payload_json, '$.titleRegeneration') AS type
        FROM orchestration_v2_projection_threads
        WHERE thread_id NOT IN ('parent', 'queued-parent', 'running-job', 'absent')
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(markers, [
        { thread_id: "cancelled-job", type: "null" },
        { thread_id: "failed-job", type: "null" },
        { thread_id: "queued-subagent", type: "null" },
        { thread_id: "subagent", type: "null" },
        { thread_id: "superseded-job", type: "null" },
      ]);
      const subagent = yield* decodeThreadPayload(after.get("subagent"));
      assert.strictEqual(subagent.titleRegeneration, null);
      assert.strictEqual(subagent.title, "subagent");
    }),
  );
});
