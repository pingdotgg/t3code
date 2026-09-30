import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
