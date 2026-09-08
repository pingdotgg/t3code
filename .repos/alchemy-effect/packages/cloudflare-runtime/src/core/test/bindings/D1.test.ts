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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

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

  batch<T = unknown>(
    statements: Array<TestD1PreparedStatement>,
  ): Promise<Array<D1Result<T>>> {
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

const SCHEMA = (
  tableColours: string,
  tableKitchenSink: string,
  tablePalettes: string,
) => `
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

class D1TestWorker extends Context.Service<D1TestWorker, TestWorker>()(
  "test/D1TestWorker",
) {}

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

const setup: Effect.Effect<D1TestContext, never, D1TestWorker> = Effect.gen(
  function* () {
    const worker = yield* D1TestWorker;
    // Namespace tables so tests accessing the same database don't have races
    // from table collisions
    const ns = `${Date.now()}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`;
    const tableColours = `colours_${ns}`;
    const tableKitchenSink = `kitchen_sink_${ns}`;
    const tablePalettes = `palettes_${ns}`;
    const db = new TestD1Database(worker.baseUrl, "DB");
    yield* Effect.promise(() =>
      db.exec(SCHEMA(tableColours, tableKitchenSink, tablePalettes)),
    );
    return { db, tableColours, tableKitchenSink, tablePalettes };
  },
);

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

const D1TestLayer = D1TestWorkerLive.pipe(
  Layer.provideMerge(localRuntimeLayer),
);

layer(D1TestLayer)("D1 binding", (it) => {
  const d1Test = (name: string, fn: (ctx: D1TestContext) => Promise<void>) =>
    it.effect(name, () =>
      setup.pipe(Effect.flatMap((ctx) => Effect.promise(() => fn(ctx)))),
    );

  d1Test("D1Database: batch", async ({ db, tableColours }) => {
    const insert = db.prepare(
      `INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`,
    );
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
    const badInsert = db.prepare(
      `PUT IN ${tableColours} (id, name, rgb) VALUES (?, ?, ?)`,
    );
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
    let execResult = await db.exec(
      `UPDATE ${tableColours} SET name = 'Red' WHERE name = 'red'`,
    );
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
    expect(result.results).toEqual([
      { name: "Red" },
      { name: "Green" },
      { name: "Blue" },
    ]);
  });

  d1Test(
    "D1PreparedStatement: bind",
    async ({ db, tableColours, tableKitchenSink }) => {
      // Check with all parameter types. (Upstream uses a `3.141` literal, which
      // trips the `approx-constant` lint rule.)
      // oxlint-disable-next-line approx-constant
      const real = 3.141;
      const blob = utf8Encode("Walshy");
      const blobArray = Array.from(blob);
      await db
        .prepare(
          `INSERT INTO ${tableKitchenSink} (id, int, real, text, blob) VALUES (?, ?, ?, ?, ?)`,
        )
        // Preserve `Uint8Array` type through JSON serialisation
        .bind(1, 42, real, "🙈", blobArray)
        .run();
      let result = await db
        .prepare(`SELECT * FROM ${tableKitchenSink}`)
        .all<KitchenSinkRow>();
      expect(result.results).toEqual([
        { id: 1, int: 42, real, text: "🙈", blob: blobArray },
      ]);

      // Check with null values
      await db
        .prepare(`UPDATE ${tableKitchenSink} SET blob = ?`)
        .bind(null)
        .run();
      result = await db.prepare(`SELECT * FROM ${tableKitchenSink}`).all();
      expect(result.results).toEqual([
        { id: 1, int: 42, real, text: "🙈", blob: null },
      ]);

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
        .prepare(
          `INSERT INTO ${tableColours} (id, name, rgb) VALUES (?3, ?1, ?2)`,
        )
        .bind("yellow", 0xffff00, 4)
        .run();
      const colourResult = await db
        .prepare(`SELECT * FROM ${tableColours} WHERE id = ?1`)
        .bind(4)
        .first<ColourRow>();
      expect(colourResult).toEqual({ id: 4, name: "yellow", rgb: 0xffff00 });
    },
  );

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
        /A prepared SQL statement must contain only one statement/.test(
          (e as Error).message,
        ),
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

  d1Test(
    "D1PreparedStatement: run",
    async ({ db, tableColours, tableKitchenSink }) => {
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
          size_after: result.meta.size_after,
          rows_read: 3,
          rows_written: 0,
        },
      });

      // Check with read/write statement
      result = await db
        .prepare(
          `INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING *`,
        )
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
            size_after: result.meta.size_after,
          },
          results: [],
          success: true,
        });
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect(
          /A prepared SQL statement must contain only one statement/.test(
            (e as Error).message,
          ),
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
          size_after: result.meta.size_after,
          rows_read: 1,
          rows_written: 1,
        },
      });
    },
  );

  d1Test("D1PreparedStatement: all", async ({ db, tableColours }) => {
    // Check with read statement
    let result = await db
      .prepare(`SELECT * FROM ${tableColours}`)
      .all<ColourRow>();
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
          size_after: result.meta.size_after,
        },
        results: [{ id: 3, name: "blue", rgb: 255 }],
        success: true,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(
        /A prepared SQL statement must contain only one statement/.test(
          (e as Error).message,
        ),
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
      .prepare(
        `INSERT INTO ${tableColours} (id, name, rgb) VALUES (?, ?, ?) RETURNING id`,
      )
      .bind(5, "orange", 0xff8000)
      .all();
    expect(result.results).toEqual([{ id: 5 }]);
    expect(result.meta.last_row_id).toBe(5);
    expect(result.meta.changes).toBe(1);
  });

  d1Test("D1PreparedStatement: raw", async ({ db, tableColours }) => {
    // Check with read statement
    type RawColourRow = [/* id */ number, /* name */ string, /* rgb*/ number];
    let results = await db
      .prepare(`SELECT * FROM ${tableColours}`)
      .raw<RawColourRow>();
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
        /A prepared SQL statement must contain only one statement/.test(
          (e as Error).message,
        ),
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
    const rawResults = await db
      .prepare(`SELECT * FROM abc, cde;`)
      .raw({ columnNames: true });
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
      .prepare(
        `INSERT INTO ${tableColours} (id, name, rgb) VALUES (4, 'pink', 0xff00ff);`,
      )
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

      // Export the database schema and data
      const result = await originalDb
        .prepare("PRAGMA miniflare_d1_export(?,?,?);")
        .bind(0, 0)
        .raw();
      const [dumpStatements] = result as [Array<string>];
      const dump = dumpStatements.join("\n");

      // Import the dump into the mirror database
      await mirrorDb.exec(dump);

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
  const classroomStmt = db.prepare(
    `INSERT INTO classrooms (id, capacity) VALUES (?, ?)`,
  );

  for (const classroom of classroomData) {
    await classroomStmt.bind(classroom.id, classroom.capacity).run();
  }

  // Generate and insert student data with classroom references
  const studentStmt = db.prepare(
    `INSERT INTO students (id, name, classroom) VALUES (?, ?, ?)`,
  );

  // Create 2 students for each classroom
  for (let i = 0; i < 10; i++) {
    for (let j = 1; j <= 2; j++) {
      const studentId = i * 2 + j;
      await studentStmt
        .bind(studentId, `student_${studentId}`, `classroom_${i + 1}`)
        .run();
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
  const tablesFromMirror = (
    await db2.prepare(selectSchemaSQL).all<{ name: string }>()
  ).results;
  const tablesFromOriginal = (
    await db.prepare(selectSchemaSQL).all<{ name: string }>()
  ).results;
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
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        );

        const runAgainstStorage = Effect.fn(
          function* (run: (db: TestD1Database) => Promise<void>) {
            const worker = yield* startTestWorker({
              name: "d1-persist-test",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
              ],
              bindings: [D1.local({ binding: "DB", id: "db" })],
            });
            yield* Effect.promise(() =>
              run(new TestD1Database(worker.baseUrl, "DB")),
            );
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage(async (db) => {
          // Check execute respects persist
          await db.exec(SCHEMA("colours", "kitchen_sink", "palettes"));
          await db
            .prepare(
              `INSERT INTO colours (id, name, rgb) VALUES (4, 'purple', 0xff00ff);`,
            )
            .run();
          const result = await db
            .prepare(`SELECT name FROM colours WHERE id = 4`)
            .first();
          expect(result).toEqual({ name: "purple" });
        });

        // Check directory created for the Durable Object SQLite databases
        const names = yield* fs.readDirectory(path.join(tmp, "d1"));
        expect(names).toContain("cloudflare-runtime-D1DatabaseObject");

        // Check "restarting" keeps persisted data
        yield* runAgainstStorage(async (db) => {
          const result = await db
            .prepare(`SELECT name FROM colours WHERE id = 4`)
            .first();
          expect(result).toEqual({ name: "purple" });
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});
