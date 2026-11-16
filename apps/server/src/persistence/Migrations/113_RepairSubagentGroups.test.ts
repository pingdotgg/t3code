import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const createdAt = "2026-11-15T00:00:00.000Z";
const group = {
  status: "active",
  primary: { model: "gpt-5.4", label: "GPT", handle: "gpt" },
  seats: [
    {
      threadId: "thread:seat",
      handle: "claude",
      label: "Claude",
      status: "seated",
      joinedAfterRun: 1,
    },
  ],
  discussion: { mode: "everyone", turnsLeft: 2, delivering: ["primary"] },
  closedBecause: null,
  closedAt: null,
};

function threadPayload(id: string, lineage: object, extras: object = {}) {
  return {
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
    lineage,
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    group,
    ...extras,
  };
}

layer("113_RepairSubagentGroups", (it) => {
  it.effect("removes a copied group from a subagent and leaves the owner and the seat", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 112 });
      const rows: ReadonlyArray<readonly [string, object]> = [
        [
          "owner",
          threadPayload("owner", {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: "owner",
          }),
        ],
        [
          "seat",
          threadPayload("seat", {
            parentThreadId: "owner",
            relationshipToParent: "fork",
            rootThreadId: "owner",
            sideChat: true,
          }),
        ],
        [
          "subagent",
          threadPayload(
            "subagent",
            {
              parentThreadId: "owner",
              relationshipToParent: "subagent",
              rootThreadId: "owner",
            },
            {
              lastSnoozeWakeAt: createdAt,
              activeOrderKey: "parent-active",
              opens: { openedAt: 1_753_348_800_000, score: 4, picks: [] },
            },
          ),
        ],
        [
          "subagent-null",
          threadPayload(
            "subagent-null",
            {
              parentThreadId: "owner",
              relationshipToParent: "subagent",
              rootThreadId: "owner",
            },
            { group: null },
          ),
        ],
      ];
      for (const [id, payload] of rows) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${JSON.stringify(payload)}
          )
        `;
      }

      const read = sql<{
        readonly thread_id: string;
        readonly payload_json: string;
        readonly group_type: string | null;
      }>`
        SELECT thread_id, payload_json, json_type(payload_json, '$.group') AS group_type
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
      const before = yield* read;
      assert.deepStrictEqual(
        before.map((row) => [row.thread_id, row.group_type]),
        [
          ["owner", "object"],
          ["seat", "object"],
          ["subagent", "object"],
          ["subagent-null", "null"],
        ],
      );

      yield* runMigrations({ toMigrationInclusive: 113 });
      const after = new Map((yield* read).map((row) => [row.thread_id, row]));
      for (const id of ["owner", "seat", "subagent-null"]) {
        const earlier = before.find((row) => row.thread_id === id);
        assert.strictEqual(after.get(id)?.payload_json, earlier?.payload_json);
      }
      const subagent = after.get("subagent");
      assert.strictEqual(subagent?.group_type, null);
      const kept = yield* sql<{
        readonly wake: string | null;
        readonly order_key: string | null;
        readonly opens_score: number | null;
      }>`
        SELECT json_extract(payload_json, '$.lastSnoozeWakeAt') AS wake,
          json_extract(payload_json, '$.activeOrderKey') AS order_key,
          json_extract(payload_json, '$.opens.score') AS opens_score
        FROM orchestration_v2_projection_threads
        WHERE thread_id = 'subagent'
      `;
      assert.deepStrictEqual(kept, [
        { wake: createdAt, order_key: "parent-active", opens_score: 4 },
      ]);
    }),
  );
});
