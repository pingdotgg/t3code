import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./SqliteClient.ts";

it.effect("runs prepared queries and returns positional values", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
    yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

    const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, "alpha");
    assert.equal(rows[1]?.name, "beta");

    const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
    assert.equal(values.length, 2);
    assert.equal(values[0]?.[1], "alpha");
    assert.equal(values[1]?.[1], "beta");
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);
