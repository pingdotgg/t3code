import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("019_ProjectionSnapshotLookupIndexes", (it) => {
  it.effect("creates indexes for targeted projection lookup filters", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 18 });
      yield* runMigrations({ toMigrationInclusive: 19 });

      const projectIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_projects)
      `;
      assert.ok(
        projectIndexes.some(
          (index) => index.name === "idx_projection_projects_workspace_root_deleted_at",
        ),
      );

      const projectIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_projects_workspace_root_deleted_at')
      `;
      assert.deepStrictEqual(
        projectIndexColumns.map((column) => column.name),
        ["workspace_root", "deleted_at"],
      );

      const threadIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(
        threadIndexes.some(
          (index) => index.name === "idx_projection_threads_project_deleted_created",
        ),
      );

      const threadIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_threads_project_deleted_created')
      `;
      assert.deepStrictEqual(
        threadIndexColumns.map((column) => column.name),
        ["project_id", "deleted_at", "created_at"],
      );
    }),
  );
});
