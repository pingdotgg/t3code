import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { makeDatabaseCapability } from "./DatabaseCapability.ts";

it.effect("database.client runs a tagged-template query", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cap = makeDatabaseCapability(sql);

    yield* cap.client`CREATE TABLE t_probe (x INTEGER)`.unprepared;
    yield* cap.client`INSERT INTO t_probe (x) VALUES (1)`.unprepared;
    const rows = yield* cap.client<{ x: number }>`SELECT x FROM t_probe`;

    assert.equal(rows[0]?.x, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
