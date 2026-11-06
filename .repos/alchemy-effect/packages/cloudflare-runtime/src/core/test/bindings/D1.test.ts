// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's D1 plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/d1/*`).
 *
 * Miniflare drives the D1 binding from Node through its magic proxy; here a
 * test worker exposes the binding over HTTP and Node-side `TestD1Database` /
 * `TestD1PreparedStatement` clients mirror the `D1Database` API, so the
 * upstream test bodies port near-verbatim. D1 values are JSON-serialisable
 * (blobs travel as number arrays, exactly as in the D1 API itself), so no
 * value encoding is needed.
 *
 * Upstream tests intentionally not ported:
 * - `index.with-wrangler-shim.spec.ts`: exercises the pre-Wrangler 3.3
 *   `__D1_BETA__` shim, where the binding is a plain `Fetcher` wrapped by
 *   JavaScript injected at build time. This runtime only supports the
 *   `cloudflare-internal:d1-api` wrapped binding.
 * - "migrates database to new location": migrates pre-Durable-Object
 *   Miniflare storage; this runtime has no legacy format.
 */
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as D1 from "../../bindings/d1/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import { localRuntimeLayer, makeTempDirectory, startTestWorker } from "../helpers/runtime.ts";

// -----------------------------------------------------------------------------
// Test worker: exposes the D1 bindings over HTTP
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
export default {
  async fetch(request, env) {
    const op = await request.json();
    const db = env[op.binding];
    try {
      let result;
      switch (op.method) {
        case "exec":
          result = await db.exec(op.sql);
          break;
        case "batch": {
          const statements = op.statements.map((s) => {
            const statement = db.prepare(s.sql);
            return s.params === undefined ? statement : statement.bind(...s.params);
          });
          result = await db.batch(statements);
          break;
        }
        case "prepare": {
          let statement = db.prepare(op.sql);
          if (op.params !== undefined) statement = statement.bind(...op.params);
          switch (op.action) {
            case "all":
              result = await statement.all();
              break;
            case "run":
              result = await statement.run();
              break;
            case "raw":
              result =
                op.options === undefined
                  ? await statement.raw()
                  : await statement.raw(op.options);
              break;
            case "first":
              result =
                op.column === undefined
                  ? await statement.first()
                  : await statement.first(op.column);
              break;
          }
          break;
        }
      }
      return Response.json({ ok: true, result: result === undefined ? null : result });
    } catch (e) {
      return Response.json({
        ok: false,
        message: e?.message ?? String(e),
        cause: e?.cause?.message,
      });
    }
  },
};
`;

// -----------------------------------------------------------------------------
// Node-side D1 client
// -----------------------------------------------------------------------------

/** JSON-serialisable D1 value: blobs travel as number arrays. */
type D1Value = number | string | null | Array<number>;

interface D1Result<T = unknown> {
  success: true;
  results: Array<T>;
  meta: {
    served_by: string;
    served_by_primary: boolean;
    total_attempts: number;
    timings: { sql_duration_ms: number };
    duration: number;
    changes: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    rows_read: number;
    rows_written: number;
  };
}

/**
 * `D1Database`-shaped client over the test worker (mirrors upstream's
 * `TestD1Database` for the wrangler shim, but calls through the real
 * wrapped binding).
 */
class TestD1Database {
  constructor(
    readonly baseUrl: URL,
    readonly binding: string,
  ) {}

  async send(op: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      body: JSON.stringify({ binding: this.binding, ...op }),
    });
    const body = (await res.json()) as
      | { ok: true; result: unknown }
      | { ok: false; message: string; cause?: string };
    if (!body.ok) {
      // Rethrow preserving the cause chain: D1 errors are
      // `Error("D1_ERROR", { cause })` with the real message in the cause
      throw new Error(
        body.message,
        body.cause === undefined ? undefined : { cause: new Error(body.cause) },
      );
    }
    return body.result;
  }

  prepare(sql: string): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this, sql);
  }

  batch<T = unknown>(statements: Array<TestD1PreparedStatement>): Promise<Array<D1Result<T>>> {
    return this.send({
      method: "batch",
      statements: statements.map((s) => s.toJSON()),
    });
  }

  exec(sql: string): Promise<{ count: number; duration: number }> {
    return this.send({ method: "exec", sql });
  }
}

class TestD1PreparedStatement {
  constructor(
    private readonly db: TestD1Database,
    private readonly sql: string,
    private readonly params?: Array<unknown>,
  ) {}

  toJSON(): { sql: string; params?: Array<unknown> } {
    return { sql: this.sql, params: this.params };
  }

  bind(...params: Array<unknown>): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.db, this.sql, params);
  }

  first<T = unknown>(column?: string): Promise<T | null> {
    return this.db.send({
      method: "prepare",
      action: "first",
      column,
      ...this.toJSON(),
    });
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    return this.db.send({ method: "prepare", action: "run", ...this.toJSON() });
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    return this.db.send({ method: "prepare", action: "all", ...this.toJSON() });
  }

  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<Array<T>> {
    return this.db.send({
      method: "prepare",
      action: "raw",
      options,
      ...this.toJSON(),
    });
  }
}

// -----------------------------------------------------------------------------
// Shared test worker and schema
// -----------------------------------------------------------------------------

const SCHEMA = (tableColours: string, tableKitchenSink: string, tablePalettes: string) => `
CREATE TABLE ${tableColours} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb INTEGER NOT NULL);
CREATE TABLE ${tableKitchenSink} (id INTEGER PRIMARY KEY, int INTEGER, real REAL, text TEXT, blob BLOB);
CREATE TABLE ${tablePalettes} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, colour_id INTEGER NOT NULL, FOREIGN KEY (colour_id) REFERENCES ${tableColours}(id));
INSERT INTO ${tableColours} (id, name, rgb) VALUES (1, 'red', 0xff0000);
INSERT INTO ${tableColours} (id, name, rgb) VALUES (2, 'green', 0x00ff00);
INSERT INTO ${tableColours} (id, name, rgb) VALUES (3, 'blue', 0x0000ff);
INSERT INTO ${tablePalettes} (id, name, colour_id) VALUES (1, 'Night', 3);
`;

interface ColourRow {
  id: number;
  name: string;
  rgb: number;
}

interface KitchenSinkRow {
  id: number;
  int: number | null;
  real: number | null;
  text: string | null;
  blob: Array<number> | null;
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function throwCause<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    assert.strictEqual(error.message, "D1_ERROR");
    assert.notStrictEqual(error.cause, undefined);
    throw error.cause;
  });
}

class D1TestWorker extends Context.Service<D1TestWorker, TestWorker>()("test/D1TestWorker") {}

const D1TestWorkerLive = Layer.effect(
  D1TestWorker,
  startTestWorker({
    name: "d1-test",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [
      D1.local({ binding: "DB", id: "db" }),
      // Upstream's "operations permit strange database names" swaps the id
      // via `setOptions`; this runtime configures workers statically, so the
      // strange database gets its own binding
      D1.local({ binding: "DB_STRANGE", id: "my/ Database" }),
      // Fresh databases for the dumpSql export/import test (upstream uses two
      // separate Miniflare instances)
      D1.local({ binding: "EXPORT_SRC", id: "export-src" }),
      D1.local({ binding: "EXPORT_DST", id: "export-dst" }),
    ],
  }),
);

interface D1TestContext {
  db: TestD1Database;
  tableColours: string;
  tableKitchenSink: string;
  tablePalettes: string;
}

const setup: Effect.Effect<D1TestContext, never, D1TestWorker> = Effect.gen(function* () {
  const worker = yield* D1TestWorker;
  // Namespace tables so tests accessing the same database don't have races
  // from table collisions
  const ns = `${Date.now()}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
  const tableColours = `colours_${ns}`;
  const tableKitchenSink = `kitchen_sink_${ns}`;
  const tablePalettes = `palettes_${ns}`;
  const db = new TestD1Database(worker.baseUrl, "DB");
  yield* Effect.promise(() => db.exec(SCHEMA(tableColours, tableKitchenSink, tablePalettes)));
  return { db, tableColours, tableKitchenSink, tablePalettes };
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const D1TestLayer = D1TestWorkerLive.pipe(Layer.provideMerge(localRuntimeLayer));

layer(D1TestLayer)("D1 binding", (it) => {
  const d1Test = (name: string, fn: (ctx: D1TestContext) => Promise<void>) =>
    it.effect(name, () => setup.pipe(Effect.flatMap((ctx) => Effect.promise(() => fn(ctx)))));

  d1Test("D1Database: batch", async ({ db, tableColours }) => {
    const insert = db.prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`);
    const batchResults = await db.batch<Pick<ColourRow, "name">>([
      insert.bind(4, "yellow", 0xffff00),
      db.prepare(`SELECT name FROM ${tableColours}`),
    ]);
    expect(batchResults.length).toBe(2);
    expect(batchResults[0].success).toBe(true);
    expect(batchResults[0].results).toEqual([]);
    expect(batchResults[1].success).toBe(true);
    const expectedResults = [
      { name: "red" },
      { name: "green" },
      { name: "blue" },
      { name: "yellow" },
    ];
    expect(batchResults[1].results).toEqual(expectedResults);

    // Check error mid-batch rolls-back entire batch
    const badInsert = db.prepare(`PUT IN ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`);
    await expect(
      throwCause(
        db.batch([
          insert.bind(5, "purple", 0xff00ff),
          badInsert.bind(6, "blurple", 0x5865f2),
          insert.bind(7, "cyan", 0x00ffff),
        ]),
      ),
    ).rejects.toThrow(/syntax error/);
    const result = await db
      .prepare(`SELECT name FROM ${tableColours}`)
      .all<Pick<ColourRow, "name">>();
    expect(result.results).toEqual(expectedResults);
  });

  d1Test("D1Database: exec", async ({ db, tableColours }) => {
    // Check with single statement
    let execResult = await db.exec(`UPDATE ${tableColours} SET name = 'Red' WHERE name = 'red'`);
    expect(execResult.count).toBe(1);
    expect(execResult.duration >= 0).toBe(true);
    let result = await db
      .prepare(`SELECT name FROM ${tableColours} WHERE name = 'Red'`)
      .all<Pick<ColourRow, "name">>();
    expect(result.results).toEqual([{ name: "Red" }]);

    // Check with multiple statements
    const statements = [
      `UPDATE ${tableColours} SET name = 'Green' WHERE name = 'green'`,
      `UPDATE ${tableColours} SET name = 'Blue' WHERE name = 'blue'`,
    ].join("\n");
    execResult = await db.exec(statements);
    expect(execResult.count).toBe(2);
    expect(execResult.duration >= 0).toBe(true);
    result = await db.prepare(`SELECT name FROM ${tableColours}`).all();
    expect(result.results).toEqual([{ name: "Red" }, { name: "Green" }, { name: "Blue" }]);
  });

  d1Test("D1PreparedStatement: bind", async ({ db, tableColours, tableKitchenSink }) => {
    // Check with all parameter types. (Upstream uses a `3.141` literal, which
    // trips the `approx-constant` lint rule.)
    // oxlint-disable-next-line approx-constant
    const real = 3.141;
    const blob = utf8Encode("Walshy");
    const blobArray = Array.from(blob);
    await db
      .prepare(`INSERT INTO ${tableKitchenSink} (id, int, real, text, blob) VALUES (?, ?, ?, ?, ?)`)
      // Preserve `Uint8Array` type through JSON serialisation
      .bind(1, 42, real, "🙈", blobArray)
      .run();
    let result = await db.prepare(`SELECT * FROM ${tableKitchenSink}`).all<KitchenSinkRow>();
    expect(result.results).toEqual([{ id: 1, int: 42, real, text: "🙈", blob: blobArray }]);

    // Check with null values
    await db.prepare(`UPDATE ${tableKitchenSink} SET blob = ?`).bind(null).run();
    result = await db.prepare(`SELECT * FROM ${tableKitchenSink}`).all();
    expect(result.results).toEqual([{ id: 1, int: 42, real, text: "🙈", blob: null }]);

    // Check with multiple statements
    const colourResultsPromise = db
      .prepare(
        `SELECT * FROM ${tableColours} WHERE name = ?; SELECT * FROM ${tableColours} WHERE id = ?;`,
      )
      .bind("green")
      .all<ColourRow>();

    // workerd changed the error message here. Miniflare's tests should pass
    // with either version of workerd
    await expect(throwCause(colourResultsPromise)).rejects.toThrow(
      /A prepared SQL statement must contain only one statement|When executing multiple SQL statements in a single call, only the last statement can have parameters./,
    );

    // Check with numbered parameters (execute and query)
    // https://github.com/cloudflare/miniflare/issues/504
    await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?3, ?1, ?2)`)
      .bind("yellow", 0xffff00, 4)
      .run();
    const colourResult = await db
      .prepare(`SELECT * FROM ${tableColours} WHERE id = ?1`)
      .bind(4)
      .first<ColourRow>();
    expect(colourResult).toEqual({ id: 4, name: "yellow", rgb: 0xffff00 });
  });

  // Lots of strange edge cases here...

  d1Test("D1PreparedStatement: first", async ({ db, tableColours }) => {
    // Check with read statement
    const select = db.prepare(`SELECT * FROM ${tableColours}`);
    let result: ColourRow | null = await select.first<ColourRow>();
    expect(result).toEqual({ id: 1, name: "red", rgb: 0xff0000 });
    let id: number | null = await select.first<number>("id");
    expect(id).toBe(1);

    // Check with multiple statements
    const resultPromise = db
      .prepare(
        `SELECT * FROM ${tableColours} WHERE name = 'none'; SELECT * FROM ${tableColours} WHERE id = 1;`,
      )
      .first();

    // workerd changed its behaviour from throwing to returning the last
    // result. Miniflare's tests should pass with either version of workerd
    try {
      const d1Result = await resultPromise;
      expect(d1Result).toEqual({ id: 1, name: "red", rgb: 16711680 });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(
        /A prepared SQL statement must contain only one statement/.test((e as Error).message),
      ).toBeTruthy();
    }

    // Check with write statement (should actually execute statement)
    result = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
      .bind(4, "yellow", 0xffff00)
      .first();
    expect(result).toBe(null);
    id = await db
      .prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
      .bind("yellow")
      .first("id");
    expect(id).toBe(4);
  });

  d1Test("D1PreparedStatement: run", async ({ db, tableColours, tableKitchenSink }) => {
    // Check with read statement
    let result = await db.prepare(`SELECT * FROM ${tableColours}`).run();
    expect(result.meta.duration >= 0).toBe(true);
    expect(result).toEqual({
      success: true,
      results: [
        { id: 1, name: "red", rgb: 16711680 },
        { id: 2, name: "green", rgb: 65280 },
        { id: 3, name: "blue", rgb: 255 },
      ],
      meta: {
        changed_db: false,
        changes: 0,
        // Don't know duration, so just match on returned value asserted > 0
        duration: result.meta.duration,
        // Not an `INSERT`, so `last_row_id` non-deterministic
        last_row_id: result.meta.last_row_id,
        served_by: "miniflare.db",
        served_by_primary: true,
        total_attempts: 1,
        timings: { sql_duration_ms: result.meta.duration },
        size_after: result.meta.size_after,
        rows_read: 3,
        rows_written: 0,
      },
    });

    // Check with read/write statement
    result = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING *`)
      .bind(4, "yellow", 0xffff00)
      .run();
    expect(result.meta.duration >= 0).toBe(true);
    expect(result).toEqual({
      results: [{ id: 4, name: "yellow", rgb: 16776960 }],
      success: true,
      meta: {
        changed_db: true,
        changes: 1,
        duration: result.meta.duration,
        last_row_id: 4,
        served_by: "miniflare.db",
        served_by_primary: true,
        total_attempts: 1,
        timings: { sql_duration_ms: result.meta.duration },
        size_after: result.meta.size_after,
        rows_read: 2,
        rows_written: 1,
      },
    });

    // Check with multiple statements
    const resultPromise = db
      .prepare(
        `INSERT INTO ${tableKitchenSink} (id) VALUES (1); INSERT INTO ${tableKitchenSink} (id) VALUES (2);`,
      )
      .run();

    // workerd changed its behaviour from throwing to returning the last
    // result. Miniflare's tests should pass with either version of workerd
    try {
      result = await resultPromise;
      expect(result).toEqual({
        meta: {
          changed_db: true,
          changes: 2,
          duration: result.meta.duration,
          last_row_id: result.meta.last_row_id,
          rows_read: 1,
          rows_written: 1,
          served_by: "miniflare.db",
          served_by_primary: true,
          total_attempts: 1,
          timings: { sql_duration_ms: result.meta.duration },
          size_after: result.meta.size_after,
        },
        results: [],
        success: true,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(
        /A prepared SQL statement must contain only one statement/.test((e as Error).message),
      ).toBeTruthy();
    }

    // Check with write statement
    result = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
      .bind(5, "orange", 0xff8000)
      .run();
    expect(result.meta.duration >= 0).toBe(true);
    expect(result).toEqual({
      results: [],
      success: true,
      meta: {
        changed_db: true,
        changes: 1,
        duration: result.meta.duration,
        last_row_id: 5,
        served_by: "miniflare.db",
        served_by_primary: true,
        total_attempts: 1,
        timings: { sql_duration_ms: result.meta.duration },
        size_after: result.meta.size_after,
        rows_read: 1,
        rows_written: 1,
      },
    });
  });

  d1Test("D1PreparedStatement: all", async ({ db, tableColours }) => {
    // Check with read statement
    let result = await db.prepare(`SELECT * FROM ${tableColours}`).all<ColourRow>();
    expect(result.meta.duration >= 0).toBe(true);
    expect(result).toEqual({
      results: [
        { id: 1, name: "red", rgb: 0xff0000 },
        { id: 2, name: "green", rgb: 0x00ff00 },
        { id: 3, name: "blue", rgb: 0x0000ff },
      ],
      success: true,
      meta: {
        changed_db: false,
        changes: 0,
        duration: result.meta.duration,
        last_row_id: result.meta.last_row_id,
        served_by: "miniflare.db",
        served_by_primary: true,
        total_attempts: 1,
        timings: { sql_duration_ms: result.meta.duration },
        size_after: result.meta.size_after,
        rows_read: 3,
        rows_written: 0,
      },
    });

    // Check with multiple statements
    const resultPromise = db
      .prepare(
        `SELECT * FROM ${tableColours} WHERE id = 1; SELECT * FROM ${tableColours} WHERE id = 3;`,
      )
      .all<ColourRow>();

    // workerd changed its behaviour from throwing to returning the last
    // result. Miniflare's tests should pass with either version of workerd
    try {
      result = await resultPromise;
      expect(result).toEqual({
        meta: {
          changed_db: false,
          changes: 0,
          duration: result.meta.duration,
          last_row_id: result.meta.last_row_id,
          rows_read: 1,
          rows_written: 0,
          served_by: "miniflare.db",
          served_by_primary: true,
          total_attempts: 1,
          timings: { sql_duration_ms: result.meta.duration },
          size_after: result.meta.size_after,
        },
        results: [{ id: 3, name: "blue", rgb: 255 }],
        success: true,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(
        /A prepared SQL statement must contain only one statement/.test((e as Error).message),
      ).toBeTruthy();
    }

    // Check with write statement (should actually execute, but return nothing)
    result = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
      .bind(4, "yellow", 0xffff00)
      .all();
    expect(result.results).toEqual([]);
    expect(result.meta.last_row_id).toBe(4);
    expect(result.meta.changes).toBe(1);
    const id = await db
      .prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
      .bind("yellow")
      .first("id");
    expect(id).toBe(4);

    // Check with write statement that returns data
    result = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING id`)
      .bind(5, "orange", 0xff8000)
      .all();
    expect(result.results).toEqual([{ id: 5 }]);
    expect(result.meta.last_row_id).toBe(5);
    expect(result.meta.changes).toBe(1);
  });

  d1Test("D1PreparedStatement: raw", async ({ db, tableColours }) => {
    // Check with read statement
    type RawColourRow = [/* id */ number, /* name */ string, /* rgb*/ number];
    let results = await db.prepare(`SELECT * FROM ${tableColours}`).raw<RawColourRow>();
    expect(results).toEqual([
      [1, "red", 0xff0000],
      [2, "green", 0x00ff00],
      [3, "blue", 0x0000ff],
    ]);

    // Check with multiple statements (should only return first statement
    // results)
    const resultPromise = db
      .prepare(
        `SELECT * FROM ${tableColours} WHERE id = 1; SELECT * FROM ${tableColours} WHERE id = 3;`,
      )
      .raw<RawColourRow>();

    // workerd changed its behaviour from throwing to returning the last
    // result. Miniflare's tests should pass with either version of workerd
    try {
      const result = await resultPromise;
      expect(result).toEqual([[3, "blue", 0x0000ff]]);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(
        /A prepared SQL statement must contain only one statement/.test((e as Error).message),
      ).toBeTruthy();
    }

    // Check with write statement (should actually execute, but return nothing)
    results = await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`)
      .bind(4, "yellow", 0xffff00)
      .raw();
    expect(results).toEqual([]);
    const id = await db
      .prepare(`SELECT id FROM ${tableColours} WHERE name = ?`)
      .bind("yellow")
      .first("id");
    expect(id).toBe(4);

    // Check whether workerd raw test case passes here too
    await db.prepare(`CREATE TABLE abc (a INT, b INT, c INT);`).run();
    await db.prepare(`CREATE TABLE cde (c INT, d INT, e INT);`).run();
    await db.prepare(`INSERT INTO abc VALUES (1,2,3),(4,5,6);`).run();
    await db.prepare(`INSERT INTO cde VALUES (7,8,9),(1,2,3);`).run();
    const rawResults = await db.prepare(`SELECT * FROM abc, cde;`).raw({ columnNames: true });
    expect(rawResults).toEqual([
      ["a", "b", "c", "c", "d", "e"],
      [1, 2, 3, 7, 8, 9],
      [1, 2, 3, 1, 2, 3],
      [4, 5, 6, 7, 8, 9],
      [4, 5, 6, 1, 2, 3],
    ]);
  });

  d1Test("it properly handles ROWS_AND_COLUMNS results format", async (ctx) => {
    const { db, tableColours, tablePalettes } = ctx;
    const results = await db
      .prepare(
        `SELECT ${tableColours}.name, ${tablePalettes}.name FROM ${tableColours} JOIN ${tablePalettes} ON ${tableColours}.id = ${tablePalettes}.colour_id`,
      )
      .raw();
    expect(results).toEqual([["blue", "Night"]]);
  });

  d1Test("operations permit strange database names", async (ctx) => {
    const { tableColours, tableKitchenSink, tablePalettes } = ctx;
    const db = new TestD1Database(ctx.db.baseUrl, "DB_STRANGE");

    // Check basic operations work
    await db.exec(SCHEMA(tableColours, tableKitchenSink, tablePalettes));

    await db
      .prepare(`INSERT INTO ${tableColours} (id, name, rgb) VALUES (4, 'pink', 0xff00ff);`)
      .run();
    const result = await db
      .prepare(`SELECT name FROM ${tableColours} WHERE id = 4`)
      .first<Pick<ColourRow, "name">>();
    expect(result).toEqual({ name: "pink" });
  });

  /**
   * Test that the export pragma returns a valid SQL dump of the database.
   * This test fills a fresh D1 database with dummy data, exports the SQL dump
   * using the `PRAGMA miniflare_d1_export` command, executes the dump in a
   * second fresh D1 database, and checks if both databases are equal in terms
   * of schema and data.
   */
  d1Test(
    "dumpSql exports and imports complete database structure and content correctly",
    async (ctx) => {
      const originalDb = new TestD1Database(ctx.db.baseUrl, "EXPORT_SRC");
      const mirrorDb = new TestD1Database(ctx.db.baseUrl, "EXPORT_DST");

      // Fill the original database with dummy data
      await fillDummyData(originalDb);
      await originalDb.exec(
        "INSERT INTO classrooms (id, capacity) VALUES ('positive_infinity', 9e999), ('negative_infinity', -9e999)",
      );

      // Export the database schema and data
      const result = await originalDb
        .prepare("PRAGMA miniflare_d1_export(?,?,?);")
        .bind(0, 0)
        .raw();
      const [dumpStatements] = result as [Array<string>];
      const dump = dumpStatements.join("\n");
      expect(dump).toContain("9e999");
      expect(dump).toContain("-9e999");

      // Import the dump into the mirror database
      await mirrorDb.exec(dump);
      expect(
        (
          await mirrorDb
            .prepare(
              "SELECT capacity > 1e308 AS positive, capacity < -1e308 AS negative FROM classrooms WHERE id LIKE '%infinity' ORDER BY id",
            )
            .all()
        ).results,
      ).toEqual([
        { positive: 0, negative: 1 },
        { positive: 1, negative: 0 },
      ]);

      // Verify that the schema and data in both databases are equal
      await isDatabaseEqual(originalDb, mirrorDb);
    },
  );
});

/**
 * Populates a D1 database with test data for schema export testing.
 * Creates tables with various schema features (foreign keys, special
 * characters, etc.) and inserts sample data including edge cases like NULL
 * values and type mismatches.
 */
async function fillDummyData(db: TestD1Database) {
  // Create schema with various SQL features to test export compatibility.
  // Each table must have an ID column as primary key so that we can use it
  // for ordering in equality tests

  const schemas = [
    // Create basic table with text primary key
    `CREATE TABLE "classrooms"(id TEXT PRIMARY KEY, capacity INTEGER, test_blob BLOB)`,

    // Create table with foreign key constraint
    `CREATE TABLE "students" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, classroom TEXT NOT NULL, FOREIGN KEY (classroom) REFERENCES "classrooms" (id) ON DELETE CASCADE)`,

    // Create table with spaces in name to test quoting
    `CREATE TABLE "test space table" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,

    // Create table with escaped quotes and SQL reserved keywords
    `CREATE TABLE "test""name" (id INTEGER PRIMARY KEY, "escaped""column" TEXT, "order" INTEGER)`,
  ];

  await db.exec(schemas.join(";"));

  // Prepare sample data
  const classroomData: Array<{ id: string; capacity: D1Value }> = [
    // Standard numeric data
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `classroom_${i + 1}`,
      capacity: (i + 1) * 10,
    })),

    // Edge case: type mismatch (string where number expected)
    { id: "different_type_classroom", capacity: "not_a_number" },

    // Edge case: NULL value
    { id: "null_classroom", capacity: null },
  ];

  // Insert classroom data
  const classroomStmt = db.prepare(`INSERT INTO classrooms (id, capacity) VALUES (?, ?)`);

  for (const classroom of classroomData) {
    await classroomStmt.bind(classroom.id, classroom.capacity).run();
  }

  // Generate and insert student data with classroom references
  const studentStmt = db.prepare(`INSERT INTO students (id, name, classroom) VALUES (?, ?, ?)`);

  // Create 2 students for each classroom
  for (let i = 0; i < 10; i++) {
    for (let j = 1; j <= 2; j++) {
      const studentId = i * 2 + j;
      await studentStmt.bind(studentId, `student_${studentId}`, `classroom_${i + 1}`).run();
    }
  }
}

/**
 * Compares two D1 databases to check if they are equal in terms of schema and
 * data. It retrieves the schema of both databases, compares the tables, and
 * then checks if the data in each table is identical.
 */
async function isDatabaseEqual(db: TestD1Database, db2: TestD1Database) {
  // SQL to select schema excluding internal tables
  const selectSchemaSQL =
    "SELECT * FROM sqlite_master WHERE type = 'table' AND (name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%')";

  // Check if schema (tables) in both databases is equal
  const tablesFromMirror = (await db2.prepare(selectSchemaSQL).all<{ name: string }>()).results;
  const tablesFromOriginal = (await db.prepare(selectSchemaSQL).all<{ name: string }>()).results;
  expect(tablesFromMirror).toEqual(tablesFromOriginal);

  // Check if data in each table is equal. We will use a simple
  // SELECT * FROM table ORDER BY id to ensure consistent ordering
  for (const table of tablesFromMirror) {
    const tableName = table.name;

    // Escape and ORDER BY to ensure consistent ordering
    const selectTableSQL = `SELECT * FROM "${tableName.replace(/"/g, '""')}" ORDER BY id ASC`;

    const originalData = (await db.prepare(selectTableSQL).all()).results;
    const mirrorData = (await db2.prepare(selectTableSQL).all()).results;

    // Data mismatch in table: ${tableName}
    expect(originalData).toEqual(mirrorData);
  }
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("D1 binding persistence", () => {
  it.effect(
    "operations persist D1 data",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("d1-persist-");

        const runtimeLayerTempDir = Runtime.RuntimeLive.pipe(
          Layer.provideMerge(RuntimeServices.layerLocalBindings()),
          Layer.provide(Globals.GlobalsLive),
          Layer.provideMerge(RuntimeServices.layerLoopback()),
          Layer.provide(Storage.layerDisk(tmp)),
          Layer.provide(Internet.InternetLive),
          Layer.provideMerge(RuntimeServices.layerRegistry()),
          Layer.provide(Paths.PathsLive),
          Layer.provide(Docker.DockerLive),
          Layer.provide(Workerd.WorkerdLive),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        );

        const runAgainstStorage = Effect.fn(
          function* (run: (db: TestD1Database) => Promise<void>) {
            const worker = yield* startTestWorker({
              name: "d1-persist-test",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
              bindings: [D1.local({ binding: "DB", id: "db" })],
            });
            yield* Effect.promise(() => run(new TestD1Database(worker.baseUrl, "DB")));
          },
          (self) => self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage(async (db) => {
          // Check execute respects persist
          await db.exec(SCHEMA("colours", "kitchen_sink", "palettes"));
          await db
            .prepare(`INSERT INTO colours (id, name, rgb) VALUES (4, 'purple', 0xff00ff);`)
            .run();
          const result = await db.prepare(`SELECT name FROM colours WHERE id = 4`).first();
          expect(result).toEqual({ name: "purple" });
        });

        // Check directory created for the Durable Object SQLite databases
        const names = yield* fs.readDirectory(path.join(tmp, "d1"));
        expect(names).toContain("cloudflare-runtime-D1DatabaseObject");

        // Check "restarting" keeps persisted data
        yield* runAgainstStorage(async (db) => {
          const result = await db.prepare(`SELECT name FROM colours WHERE id = 4`).first();
          expect(result).toEqual({ name: "purple" });
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

// -----------------------------------------------------------------------------
// Query RPC (`workers-sdk/packages/miniflare/test/plugins/d1/jsrpc.spec.ts`)
// -----------------------------------------------------------------------------

/**
 * Each upstream test creates a fresh Miniflare instance with `DB` and
 * `OTHER_DB` bindings. Here one worker serves every case: the case name is
 * the request path, and each case gets its own pair of databases
 * (`<case>_DB` / `<case>_OTHER_DB`) so cases never share tables.
 */
const RPC_CASES: Record<string, string> = {
  rawResults: `
    return Response.json(await DB.query({
      queries: [{ sql: "SELECT ? AS answer", params: [42] }],
    }));
  `,
  exportRestore: `
    await DB.exec("CREATE TABLE answers (id INTEGER PRIMARY KEY, answer TEXT)");
    await DB.batch([
      DB.prepare("INSERT INTO answers VALUES (?, ?)").bind(1, "first"),
      DB.prepare("INSERT INTO answers VALUES (?, ?)").bind(2, "second"),
    ]);
    const [dumpStatements] = await DB
      .prepare("PRAGMA miniflare_d1_export(?,?,?);")
      .bind(0, 0)
      .raw();
    await OTHER_DB.exec(dumpStatements.join("\\n"));
    const restored = await OTHER_DB.prepare("SELECT * FROM answers ORDER BY id").all();
    return Response.json(restored.results);
  `,
  metadataRpc: `
    const response = await DB.query({ queries: [{ sql: "SELECT ? AS answer", params: [42] }] });
    const meta = response.results[0].meta;
    return Response.json({ meta, timingMatches: meta.duration === meta.timings?.sql_duration_ms });
  `,
  metadataHttp: `
    const response = await DB.prepare("SELECT ? AS answer").bind(42).all();
    const meta = response.meta;
    return Response.json({ meta, timingMatches: meta.duration === meta.timings?.sql_duration_ms });
  `,
  errors: `
    const sql = "SELECT * FROM missing_table";
    const errors = [];
    for (const operation of [
      () => DB.query({ queries: [{ sql }] }),
      () => DB.prepare(sql).all(),
      () => DB.batch([DB.prepare(sql)]),
      () => DB.exec(sql),
    ]) {
      try {
        await operation();
        errors.push(null);
      } catch (error) {
        errors.push({
          name: error.name,
          message: error.message,
          cause: error.cause && { name: error.cause.name, message: error.cause.message },
        });
      }
    }
    return Response.json(errors);
  `,
  bookmarks: `
    const initial = await DB.query({
      queries: [{ sql: "CREATE TABLE answers (answer INTEGER)" }],
      bookmark: "first-primary",
    });
    const written = await DB.query({
      queries: [{ sql: "INSERT INTO answers VALUES (?)", params: [42] }],
      bookmark: initial.bookmark,
    });
    const read = await DB.query({
      queries: [{ sql: "SELECT answer FROM answers" }],
      bookmark: written.bookmark,
    });
    const session = DB.withSession(read.bookmark);
    const sessionRows = await session.prepare("SELECT answer FROM answers").all();
    return Response.json({
      initialBookmark: initial.bookmark,
      writtenBookmark: written.bookmark,
      read,
      sessionRows,
      sessionBookmark: session.getBookmark(),
      primaryBookmark: DB.withSession("first-primary").getBookmark(),
    });
  `,
  separateDatabases: `
    for (const [db, answer] of [[DB, 42], [OTHER_DB, 43]]) {
      await db.query({ queries: [
        { sql: "CREATE TABLE answers (answer INTEGER)" },
        { sql: "INSERT INTO answers VALUES (?)", params: [answer] },
      ] });
    }
    return Response.json({
      first: await DB.query({ queries: [{ sql: "SELECT answer FROM answers" }] }),
      second: await OTHER_DB.query({ queries: [{ sql: "SELECT answer FROM answers" }] }),
    });
  `,
  rawShapes: `
    const result = await DB.query({ queries: [
      { sql: "SELECT 42 AS answer WHERE 0" },
      { sql: "SELECT 1 AS answer, 2 AS answer" },
      { sql: "SELECT ? AS bytes, ? AS text, ? AS empty", params: [[0, 127, 255], "hello", null] },
    ] });
    return Response.json(result.results.map(({ data }) => data));
  `,
  emptyBatch: `
    return Response.json(await DB.query({ queries: [] }));
  `,
  commentOnlyBatch: `
    return Response.json(await DB.query({ queries: [{ sql: "-- no statement" }] }));
  `,
  rollback: `
    await DB.query({ queries: [{ sql: "CREATE TABLE answers (answer INTEGER)" }] });
    let failed = false;
    try {
      await DB.query({ queries: [
        { sql: "INSERT INTO answers VALUES (42)" },
        { sql: "INSERT INTO missing_table VALUES (43)" },
      ] });
    } catch {
      failed = true;
    }
    const remaining = await DB.query({ queries: [{ sql: "SELECT answer FROM answers" }] });
    return Response.json({ failed, remaining });
  `,
  invalidParams: `
    await DB.query({ queries: [{ sql: "CREATE TABLE answers (answer INTEGER)" }] });
    const rejected = [];
    // Sparse arrays: a missing parameter, and a blob with a missing byte.
    for (const params of [[NaN], [Infinity], [undefined], [[1, NaN]], Array(1), [[1, , 3]]]) {
      try {
        await DB.query({ queries: [{ sql: "INSERT INTO answers VALUES (?)", params }] });
      } catch (error) {
        rejected.push(error.name);
      }
    }
    const remaining = await DB.query({ queries: [{ sql: "SELECT answer FROM answers" }] });
    return Response.json({ rejected, rows: remaining.results[0].data.rows });
  `,
  convenience: `
    const exec = await DB.exec("CREATE TABLE answers (answer INTEGER)");
    const run = await DB.prepare("INSERT INTO answers VALUES (?)").bind(42).run();
    const statement = DB.prepare("SELECT answer FROM answers");
    return Response.json({
      exec,
      run,
      all: await statement.all(),
      first: await statement.first("answer"),
      raw: await statement.raw({ columnNames: true }),
      batch: await DB.batch([statement, DB.prepare("SELECT 43 AS answer")]),
    });
  `,
};

const RPC_SCRIPT = `
const cases = {
${Object.entries(RPC_CASES)
  .map(([name, body]) => `  async ${name}(DB, OTHER_DB) {${body}},`)
  .join("\n")}
};
export default {
  async fetch(request, env) {
    const name = new URL(request.url).pathname.slice(1);
    try {
      return await cases[name](env[name + "_DB"], env[name + "_OTHER_DB"]);
    } catch (error) {
      return Response.json({ name: error.name, message: error.message }, { status: 500 });
    }
  },
};
`;

const startRpcWorker = (transport: "RPC" | "HTTP") =>
  startTestWorker({
    name: `d1-${transport.toLowerCase()}-test`,
    compatibilityDate: "2026-08-01",
    compatibilityFlags: transport === "RPC" ? ["d1_binding_jsrpc"] : [],
    modules: [{ name: "main.js", type: "ESModule", content: RPC_SCRIPT }],
    bindings: Object.keys(RPC_CASES).flatMap((name) => [
      D1.local({ binding: `${name}_DB`, id: `${transport}-${name}-db` }),
      D1.local({ binding: `${name}_OTHER_DB`, id: `${transport}-${name}-other-db` }),
    ]),
  });

class D1QueryWorker extends Context.Service<D1QueryWorker, TestWorker>()("test/D1QueryWorker") {}

// One describe block per transport, each on its own runtime. Vitest runs them
// one after another, so two workerd processes never host D1 over the same
// storage directory, which contends for SQLite's lock (SQLITE_BUSY).
const d1QueryLayer = (transport: "RPC" | "HTTP") =>
  Layer.effect(D1QueryWorker, startRpcWorker(transport)).pipe(
    Layer.provideMerge(localRuntimeLayer),
  );

const callCase = Effect.fn(function* (name: string) {
  const worker = yield* D1QueryWorker;
  const response = yield* worker.fetch(`/${name}`);
  const body = yield* Effect.promise(() => response.json());
  return { status: response.status, body: body as unknown };
});

/** Cases both transports must pass. */
const transportCases = (transport: "RPC" | "HTTP") =>
  [
    [
      `${transport} local exports can restore schema and data into another database`,
      Effect.gen(function* () {
        const { status, body } = yield* callCase("exportRestore");
        expect(body).toEqual([
          { id: 1, answer: "first" },
          { id: 2, answer: "second" },
        ]);
        expect(status).toBe(200);
      }),
    ],
    [
      `${transport} queries report local primary, attempt, and SQL timing metadata`,
      Effect.gen(function* () {
        const { status, body } = yield* callCase(
          transport === "RPC" ? "metadataRpc" : "metadataHttp",
        );
        expect(body).toMatchObject({
          meta: {
            served_by: "miniflare.db",
            served_by_primary: true,
            total_attempts: 1,
            duration: expect.any(Number),
            timings: { sql_duration_ms: expect.any(Number) },
            changes: 0,
            last_row_id: 0,
            changed_db: false,
            size_after: expect.any(Number),
            rows_read: 0,
            rows_written: 0,
          },
          timingMatches: true,
        });
        expect(status).toBe(200);
      }),
    ],
  ] as const;

layer(d1QueryLayer("RPC"))("D1 query RPC", (it) => {
  it.effect("query returns raw parameterized results and execution metadata", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("rawResults");
      expect(body).toMatchObject({
        results: [
          {
            data: { kind: "raw", columns: ["answer"], rows: [[42]] },
            meta: {
              duration: expect.any(Number),
              rows_read: expect.any(Number),
              rows_written: expect.any(Number),
            },
          },
        ],
      });
      expect(status).toBe(200);
    }),
  );

  for (const [name, test] of transportCases("RPC")) {
    it.effect(name, () => test);
  }

  it.effect(
    "SQL errors propagate directly and convenience methods preserve their prefixes and causes",
    () =>
      Effect.gen(function* () {
        const { status, body } = yield* callCase("errors");
        const backendError = {
          name: "D1_ERROR",
          message: expect.stringMatching(/^no such table: missing_table/),
        };
        expect(body).toEqual([
          backendError,
          {
            name: "Error",
            message: expect.stringMatching(/^D1_ERROR: no such table: missing_table/),
            cause: backendError,
          },
          {
            name: "Error",
            message: expect.stringMatching(/^D1_ERROR: no such table: missing_table/),
            cause: backendError,
          },
          {
            name: "Error",
            message: expect.stringMatching(/^D1_EXEC_ERROR: no such table: missing_table/),
            cause: backendError,
          },
        ]);
        expect(status).toBe(200);
      }),
  );

  it.effect("query bookmarks can be reused and sessions observe committed writes", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("bookmarks");
      expect(body).toMatchObject({
        initialBookmark: expect.stringMatching(/.+/),
        writtenBookmark: expect.stringMatching(/.+/),
        read: {
          bookmark: expect.stringMatching(/.+/),
          results: [{ data: { kind: "raw", columns: ["answer"], rows: [[42]] } }],
        },
        sessionRows: { success: true, results: [{ answer: 42 }] },
        sessionBookmark: expect.stringMatching(/.+/),
        primaryBookmark: null,
      });
      expect(status).toBe(200);
    }),
  );

  it.effect("bindings route RPC queries to separate databases", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("separateDatabases");
      expect(body).toMatchObject({
        first: { results: [{ data: { kind: "raw", columns: ["answer"], rows: [[42]] } }] },
        second: { results: [{ data: { kind: "raw", columns: ["answer"], rows: [[43]] } }] },
      });
      expect(status).toBe(200);
    }),
  );

  it.effect("raw query results preserve empty rows, duplicate columns, and blobs", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("rawShapes");
      expect(body).toEqual([
        { kind: "raw", columns: ["answer"], rows: [] },
        { kind: "raw", columns: ["answer", "answer"], rows: [[1, 2]] },
        {
          kind: "raw",
          columns: ["bytes", "text", "empty"],
          rows: [[[0, 127, 255], "hello", null]],
        },
      ]);
      expect(status).toBe(200);
    }),
  );

  for (const { name, path, message } of [
    { name: "empty", path: "emptyBatch", message: "No SQL statements detected." },
    {
      name: "comment-only",
      path: "commentOnlyBatch",
      message: "SQL code did not contain a statement.",
    },
  ]) {
    it.effect(`query rejects a ${name} batch without returning partial results`, () =>
      Effect.gen(function* () {
        const { status, body } = yield* callCase(path);
        expect(body).toEqual({ name: "D1_ERROR", message });
        expect(status).toBe(500);
      }),
    );
  }

  it.effect("a failed query batch rolls back earlier writes", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("rollback");
      expect(body).toMatchObject({
        failed: true,
        remaining: { results: [{ data: { kind: "raw", columns: ["answer"], rows: [] } }] },
      });
      expect(status).toBe(200);
    }),
  );

  it.effect("query rejects non-finite and missing parameters instead of storing NULL", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("invalidParams");
      expect(body).toEqual({
        rejected: Array(6).fill("TypeError"),
        rows: [],
      });
      expect(status).toBe(200);
    }),
  );

  it.effect("prepared statements and batches retain their convenience results over RPC", () =>
    Effect.gen(function* () {
      const { status, body } = yield* callCase("convenience");
      expect(body).toMatchObject({
        exec: { count: 1, duration: expect.any(Number) },
        run: { success: true, results: [], meta: { changes: 1, rows_written: 1 } },
        all: { success: true, results: [{ answer: 42 }] },
        first: 42,
        raw: [["answer"], [42]],
        batch: [
          { success: true, results: [{ answer: 42 }] },
          { success: true, results: [{ answer: 43 }] },
        ],
      });
      expect(status).toBe(200);
    }),
  );
});

layer(d1QueryLayer("HTTP"))("D1 query over HTTP", (it) => {
  for (const [name, test] of transportCases("HTTP")) {
    it.effect(name, () => test);
  }
});

// -----------------------------------------------------------------------------
// Session bookmark failures (`test/plugins/d1/index.spec.ts`)
// -----------------------------------------------------------------------------

const SESSION_SCRIPT = `
const fail = (error) =>
  Response.json({ ok: false, message: error.message, cause: error.cause?.message });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const db = env.DATABASE;
    try {
      switch (url.pathname) {
        case "/setup":
          await db.prepare("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)").run();
          return Response.json({ ok: true });
        case "/select":
          return Response.json({
            ok: true,
            results: (await db.prepare("SELECT * FROM entries").all()).results,
          });
        case "/session-start": {
          const session = db.withSession("first-primary");
          await session.prepare("SELECT * FROM entries").all();
          return Response.json({ ok: true, bookmark: session.getBookmark() });
        }
        case "/session-write": {
          const session = db.withSession(url.searchParams.get("bookmark"));
          const insert = session.prepare("INSERT INTO entries (value) VALUES ('order')");
          try {
            if (url.searchParams.get("method") === "run") await insert.run();
            else await session.batch([insert, insert]);
          } catch (error) {
            return Response.json({
              ok: false,
              message: error.message,
              cause: error.cause?.message,
              bookmark: session.getBookmark(),
            });
          }
          const { results } = await session.prepare("SELECT * FROM entries").all();
          return Response.json({ ok: true, results, bookmark: session.getBookmark() });
        }
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return fail(error);
    }
  },
};
`;

interface SessionResponse {
  ok: boolean;
  message?: string;
  cause?: string;
  bookmark?: string | null;
  results?: Array<unknown>;
}

/**
 * Starts a disk-persisted D1 database and opens a second SQLite connection to
 * its Durable Object database file, for injecting SQLite failures.
 */
const withPersistedDatabase = <A>(
  run: (ctx: { worker: TestWorker; external: DatabaseSync }) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* makeTempDirectory("d1-bookmark-");

    const runtimeLayer = Runtime.RuntimeLive.pipe(
      Layer.provideMerge(RuntimeServices.layerLocalBindings()),
      Layer.provide(Globals.GlobalsLive),
      Layer.provideMerge(RuntimeServices.layerLoopback()),
      Layer.provide(Storage.layerDisk(tmp)),
      Layer.provide(Internet.InternetLive),
      Layer.provideMerge(RuntimeServices.layerRegistry()),
      Layer.provide(Paths.PathsLive),
      Layer.provide(Docker.DockerLive),
      Layer.provide(Workerd.WorkerdLive),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    );

    return yield* Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "d1-bookmark-test",
        compatibilityDate: "2025-05-01",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: SESSION_SCRIPT }],
        bindings: [D1.local({ binding: "DATABASE", id: "db" })],
      });
      const setup = yield* worker.fetchJson<SessionResponse>("/setup");
      expect(setup).toEqual({ ok: true });

      const objectDir = path.join(tmp, "d1", "cloudflare-runtime-D1DatabaseObject");
      const databaseFile = (yield* fs.readDirectory(objectDir)).find(
        (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
      );
      assert(databaseFile !== undefined);
      const external = yield* Effect.acquireRelease(
        Effect.sync(() => new DatabaseSync(path.join(objectDir, databaseFile))),
        (db) => Effect.sync(() => db.close()),
      );
      return yield* run({ worker, external });
    }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("D1 session bookmark failures", () => {
  // Regression test for https://github.com/cloudflare/workers-sdk/issues/14916.
  it.live(
    "surfaces recoverable SQLite errors as catchable D1 query errors",
    () =>
      withPersistedDatabase(({ worker, external }) =>
        Effect.gen(function* () {
          // The runtime may still be flushing its own write; retry briefly.
          yield* Effect.try(() => external.exec("BEGIN IMMEDIATE")).pipe(
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 9 }),
            Effect.orDie,
          );

          // A read succeeds while another connection holds the write lock,
          // but writing the session bookmark fails. The error must stay
          // catchable.
          const failed = yield* worker
            .fetchJson<SessionResponse>("/select")
            .pipe(Effect.ensuring(Effect.sync(() => external.exec("ROLLBACK"))));
          expect(failed).toMatchObject({
            ok: false,
            message: expect.stringMatching(/^D1_ERROR: Failed to get session commit token:/),
            cause: expect.stringMatching(/^Failed to get session commit token:/),
          });

          const after = yield* worker.fetchJson<SessionResponse>("/select");
          expect(after).toEqual({ ok: true, results: [] });
        }),
      ),
    { timeout: 30_000 },
  );

  // Regression test for https://github.com/cloudflare/workers-sdk/pull/14921#discussion_r4047630401.
  for (const method of ["run", "batch"] as const) {
    it.live(
      `rolls back ${method} writes when session bookmark retrieval fails`,
      () =>
        withPersistedDatabase(({ worker, external }) =>
          Effect.gen(function* () {
            const started = yield* worker.fetchJson<SessionResponse>("/session-start");
            const bookmark = started.bookmark;
            assert(typeof bookmark === "string");

            // A trigger on workerd's metadata table makes bookmark updates
            // fail in its trusted SQLite scope, after the user SQL has
            // succeeded. The local session bookmark is stored under metadata
            // key 2.
            external.exec(`
              CREATE TRIGGER fail_bookmark BEFORE INSERT ON _cf_METADATA
              WHEN NEW.key = 2
              BEGIN
                SELECT RAISE(ABORT, 'bookmark lookup failed');
              END;
            `);
            const write = worker.fetchJson<SessionResponse>(
              `/session-write?method=${method}&bookmark=${encodeURIComponent(bookmark)}`,
            );

            const failed = yield* write;
            expect(failed).toMatchObject({
              ok: false,
              message: expect.stringMatching(/^D1_ERROR: Failed to get session commit token:/),
              cause: expect.stringMatching(/^Failed to get session commit token:/),
              bookmark,
            });
            // Inspect through the other connection while bookmark lookup
            // still fails.
            expect(external.prepare("SELECT * FROM entries").all()).toEqual([]);

            external.exec("DROP TRIGGER fail_bookmark");
            const succeeded = yield* write;
            expect(succeeded.ok).toBe(true);
            expect(succeeded.results).toEqual(
              method === "run"
                ? [{ id: 1, value: "order" }]
                : [
                    { id: 1, value: "order" },
                    { id: 2, value: "order" },
                  ],
            );
            expect(succeeded.bookmark).not.toBe(bookmark);
          }),
        ),
      { timeout: 30_000 },
    );
  }
});
