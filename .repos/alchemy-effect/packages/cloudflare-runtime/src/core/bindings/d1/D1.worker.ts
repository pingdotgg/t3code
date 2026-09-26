// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local D1 database simulator, adapted from Miniflare's D1 plugin workers
 * (`workers-sdk/packages/miniflare/src/workers/d1/*`), collapsed into a
 * single worker.
 *
 * A single `d1` service hosts every database. The default export is the
 * entry `fetch` handler that the `cloudflare-internal:d1-api` wrapped
 * binding's `fetcher` targets: it reads the database id from `ctx.props`
 * (set on the binding's service designator) and forwards the request to the
 * `D1DatabaseObject` Durable Object instance for that database. The Durable
 * Object speaks the D1 HTTP protocol (`POST /query` and `/execute` with JSON
 * queries); data lives in Durable Object SQLite, persisted via the
 * `d1:storage` disk service.
 */
import { HttpError } from "../../internal/shared.worker.ts";
import type { D1ServiceProps } from "./D1Options.shared.ts";
import { BINDING_D1_OBJECT } from "./D1Options.shared.ts";

interface Env {
  [BINDING_D1_OBJECT]: DurableObjectNamespace;
}

export default {
  async fetch(request, env, ctx) {
    const { databaseId } = (ctx as { props: D1ServiceProps }).props;
    const stub = env[BINDING_D1_OBJECT].getByName(databaseId);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
// Database object (`workers/d1/database.worker.ts`)
// -----------------------------------------------------------------------------

type D1Value = number | string | null | Array<number>;

interface D1Query {
  sql: string;
  params?: Array<D1Value> | null;
}

const D1_EXPORT_PRAGMA = `PRAGMA miniflare_d1_export(?,?,?);`;
type D1ExportPragma = [
  { sql: typeof D1_EXPORT_PRAGMA; params: [number, number, ...Array<string>] },
];

type D1ResultsFormat = "ARRAY_OF_OBJECTS" | "ROWS_AND_COLUMNS" | "NONE";

function decodeResultsFormat(value: string | null): D1ResultsFormat {
  // Matches upstream's `z.enum([...]).catch("ARRAY_OF_OBJECTS")`
  return value === "ROWS_AND_COLUMNS" || value === "NONE"
    ? value
    : "ARRAY_OF_OBJECTS";
}

interface D1RowsAndColumns {
  columns: Array<string>;
  rows: Array<Array<D1Value>>;
}

type D1Results = D1RowsAndColumns | Array<Record<string, D1Value>> | undefined;

const SERVED_BY = "miniflare.db";
interface D1SuccessResponse {
  success: true;
  results: D1Results;
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
interface D1FailureResponse {
  success: false;
  error: string;
}

// See https://github.com/cloudflare/workerd/blob/bcaf44290296c71f396175c30b43cff6b570231f/src/cloudflare/internal/d1-api.ts#L68-L72
const D1_SESSION_COMMIT_TOKEN_HTTP_HEADER = "x-cf-d1-session-commit-token";

class D1Error extends HttpError {
  constructor(readonly cause: unknown) {
    super(500);
  }

  override toResponse(): Response {
    const error =
      typeof this.cause === "object" &&
      this.cause !== null &&
      "message" in this.cause &&
      typeof this.cause.message === "string"
        ? this.cause.message
        : String(this.cause);
    const response: D1FailureResponse = { success: false, error };
    return Response.json(response);
  }
}

function convertParams(params: D1Query["params"]): Array<SqlStorageValue> {
  return (params ?? []).map((param) =>
    // If `param` is an array, assume it's a byte array
    Array.isArray(param) ? new Uint8Array(param).buffer : param,
  );
}

function convertRows(
  rows: Array<Array<SqlStorageValue>>,
): Array<Array<D1Value>> {
  return rows.map((row) =>
    row.map((value) =>
      // If `value` is a buffer, convert it to a regular numeric array
      value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value,
    ),
  );
}

function rowsToObjects(
  columns: Array<string>,
  rows: Array<Array<D1Value>>,
): Array<Record<string, D1Value>> {
  return rows.map((row) =>
    Object.fromEntries(columns.map((name, i) => [name, row[i]])),
  );
}

export class D1DatabaseObject implements DurableObject {
  readonly #sql: SqlStorage;

  constructor(readonly state: DurableObjectState) {
    this.#sql = state.storage.sql;
  }

  #changes() {
    return this.#sql
      .exec<{ totalChanges: number; lastRowId: number }>(
        "SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId",
      )
      .one();
  }

  #query = (format: D1ResultsFormat, query: D1Query): D1SuccessResponse => {
    const beforeTime = performance.now();

    const beforeSize = this.#sql.databaseSize;
    const beforeChanges = this.#changes();

    const params = convertParams(query.params ?? []);
    const cursor = this.#sql.exec(query.sql, ...params);
    const columns = cursor.columnNames;
    const rows = convertRows(Array.from(cursor.raw()));

    let results: D1Results;
    if (format === "ROWS_AND_COLUMNS") results = { columns, rows };
    else results = rowsToObjects(columns, rows);
    // Note that the "NONE" format behaviour here is inconsistent with workerd.
    // See comment: https://github.com/cloudflare/workers-sdk/pull/5917#issuecomment-2133313156

    const afterTime = performance.now();
    const afterSize = this.#sql.databaseSize;
    const afterChanges = this.#changes();

    const duration = afterTime - beforeTime;
    const changes = afterChanges.totalChanges - beforeChanges.totalChanges;

    const hasChanges = changes !== 0;
    const lastRowChanged = afterChanges.lastRowId !== beforeChanges.lastRowId;
    const sizeChanged = afterSize !== beforeSize;
    const changed = hasChanges || lastRowChanged || sizeChanged;

    return {
      success: true,
      results,
      meta: {
        served_by: SERVED_BY,
        duration,
        changes,
        last_row_id: afterChanges.lastRowId,
        changed_db: changed,
        size_after: afterSize,
        rows_read: cursor.rowsRead,
        rows_written: cursor.rowsWritten,
      },
    };
  };

  #txn(
    queries: Array<D1Query>,
    format: D1ResultsFormat,
  ): Array<D1SuccessResponse> {
    // Filter out queries that are just comments
    queries = queries.filter(
      (query) => query.sql.replace(/^\s+--.*/gm, "").trim().length > 0,
    );
    if (queries.length === 0) {
      const error = new Error("No SQL statements detected.");
      throw new D1Error(error);
    }

    try {
      return this.state.storage.transactionSync(() =>
        queries.map(this.#query.bind(this, format)),
      );
    } catch (e) {
      throw new D1Error(e);
    }
  }

  async fetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const isQueryPath =
        url.pathname === "/query" || url.pathname === "/execute";
      if (req.method !== "POST" || !isQueryPath)
        return new Response(null, { status: 404 });
      return await this.#queryExecute(req, url);
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse();
      const error = e instanceof Error ? e : new Error(String(e));
      const fallback = error.stack ?? error.message;
      console.error(fallback);
      return new Response(fallback, { status: 500 });
    } finally {
      // Make sure the request body is consumed. Otherwise, calls which make
      // requests to this object may hang and never resolve.
      // See https://github.com/cloudflare/workerd/issues/960.
      if (req.body !== null && !req.bodyUsed) {
        await req.body.pipeTo(new WritableStream());
      }
    }
  }

  async #queryExecute(req: Request, url: URL): Promise<Response> {
    // The body is produced by workerd's `cloudflare-internal:d1-api`, so it's
    // trusted and doesn't need validation (upstream parses it with Zod)
    let queries = (await req.json()) as D1Query | Array<D1Query>;
    if (!Array.isArray(queries)) queries = [queries];

    // Special local-mode-only handlers
    if (this.#isExportPragma(queries)) {
      return this.#doExportData(queries);
    }

    const resultsFormat = decodeResultsFormat(
      url.searchParams.get("resultsFormat"),
    );

    return Response.json(this.#txn(queries, resultsFormat), {
      headers: {
        [D1_SESSION_COMMIT_TOKEN_HTTP_HEADER]:
          await this.state.storage.getCurrentBookmark(),
      },
    });
  }

  #isExportPragma(queries: Array<D1Query>): queries is D1ExportPragma {
    return (
      queries.length === 1 &&
      queries[0].sql === D1_EXPORT_PRAGMA &&
      (queries[0].params?.length || 0) >= 2
    );
  }

  #doExportData(queries: D1ExportPragma) {
    const [noSchema, noData, ...tables] = queries[0].params;
    const options = {
      noSchema: Boolean(noSchema),
      noData: Boolean(noData),
      tables,
    };
    return Response.json({
      success: true,
      results: [Array.from(dumpSql(this.#sql, options))],
      meta: {},
    });
  }
}

// -----------------------------------------------------------------------------
// SQL dump (`workers/d1/dumpSql.ts`)
// -----------------------------------------------------------------------------

// NOTE: this function duplicates the logic inside SQLite's shell.c.in as close
// as possible, with any deviations noted.
function* dumpSql(
  db: SqlStorage,
  options?: {
    noSchema?: boolean;
    noData?: boolean;
    tables?: Array<string>;
  },
) {
  // WARNING: the caller in D1 assumes non-empty exports, so think carefully
  // before removing this initial yield.
  yield `PRAGMA defer_foreign_keys=TRUE;`;

  // Empty set means include all tables
  const filterTables = new Set(options?.tables || []);
  const { noData, noSchema } = options || {};

  // Taken from SQLite shell.c.in https://github.com/sqlite/sqlite/blob/105c20648e1b05839fd0638686b95f2e3998abcb/src/shell.c.in#L8463-L8469
  const tables = db
    .exec<{ name: string; type: string; sql: string }>(
      `
    SELECT name, type, sql
      FROM sqlite_schema AS o
    WHERE (true) AND type=='table'
      AND sql NOT NULL
    ORDER BY tbl_name='sqlite_sequence', rowid;
  `,
    )
    .toArray();

  for (const { name: table, sql } of tables) {
    if (filterTables.size > 0 && !filterTables.has(table)) continue;

    if (table === "sqlite_sequence") {
      if (!noSchema) yield `DELETE FROM sqlite_sequence;`;
    } else if (table.match(/^sqlite_stat./)) {
      // This feels like it should really appear _after_ the contents of
      // sqlite_stat[1,4] but I'm choosing to match SQLite's dump output
      // exactly so writing it immediately like they do.
      if (!noSchema) yield `ANALYZE sqlite_schema;`;
    } else if (sql.startsWith(`CREATE VIRTUAL TABLE`)) {
      throw new Error(
        `D1 Export error: cannot export databases with Virtual Tables (fts5)`,
      );
    } else if (table.startsWith("_cf_") || table.startsWith("sqlite_")) {
      continue;
    } else {
      // SQLite dump has an extremely weird behaviour where, if the table was
      // explicitly quoted i.e. "Table", then in the dump it has
      // `IF NOT EXISTS` injected. I don't understand why, but on the off
      // chance there's a good reason to I am following suit.
      if (sql.match(/CREATE TABLE ['"].*/)) {
        if (!noSchema) yield `CREATE TABLE IF NOT EXISTS ${sql.substring(13)};`;
      } else {
        if (!noSchema) yield `${sql};`;
      }
    }

    if (noData) continue;
    const columns = db
      .exec<{
        cid: string;
        name: string;
        type: string;
        notnull: number;
        dflt_val: string | null;
        pk: number;
      }>(`PRAGMA table_info=${escapeId(table)}`)
      .toArray();

    const select = `SELECT ${columns.map((c) => escapeId(c.name)).join(", ")} FROM ${escapeId(table)};`;
    const rowsCursor = db.exec(select);
    const columnNames = columns.map((c) => escapeId(c.name)).join(",");
    for (const dataRow of rowsCursor.raw()) {
      const formattedCells = dataRow.map((cell: unknown, i: number) => {
        const colType = columns[i].type;
        const cellType = typeof cell;
        if (cell === null) {
          return "NULL";
        } else if (cellType === "number") {
          return cell;
        } else if (cellType === "string") {
          return outputQuotedEscapedString(cell);
        } else if (cell instanceof ArrayBuffer) {
          return `X'${Array.prototype.map
            .call(new Uint8Array(cell), (b) => b.toString(16).padStart(2, "0"))
            .join("")}'`;
        } else {
          console.error({
            message: "dumpSql: unexpected cell type",
            colType,
            cellType,
            cell,
            column: columns[i],
          });
          return "ERROR";
        }
      });

      yield `INSERT INTO ${escapeId(table)} (${columnNames}) VALUES(${formattedCells.join(",")});`;
    }
  }

  if (!noSchema) {
    // Taken from SQLite shell.c.in https://github.com/sqlite/sqlite/blob/105c20648e1b05839fd0638686b95f2e3998abcb/src/shell.c.in#L8473-L8478
    const restOfSchema = db.exec<{ name: string; sql: string }>(
      [
        "SELECT name, sql",
        "FROM sqlite_schema AS o",
        "WHERE (true) AND sql NOT NULL",
        "  AND type IN ('index', 'trigger', 'view')",
        // 'DESC' appears in the code linked above but the observed behaviour
        // of SQLite appears otherwise
        "ORDER BY type COLLATE NOCASE",
      ].join(" "),
    );
    for (const { name, sql } of restOfSchema) {
      if (filterTables.size > 0 && !filterTables.has(name)) continue;
      yield `${sql};`;
    }
  }
}

// Ported `output_quoted_escaped_string` from https://github.com/sqlite/sqlite/blob/master/src/shell.c.in#L1799-L1862
function outputQuotedEscapedString(cell: unknown) {
  let lfs = false;
  let crs = false;

  const quotesOrNewlinesRegexp = /'|(\n)|(\r)/g;

  // Function to replace ' with '', while also tracking whether the string
  // contains any \r or \n chars
  const escapeQuotesDetectingNewlines = (_: string, lf: string, cr: string) => {
    if (lf) {
      lfs = true;
      return `\\n`;
    }
    if (cr) {
      crs = true;
      return `\\r`;
    }
    return `''`;
  };

  const escapedString = (cell as string).replace(
    quotesOrNewlinesRegexp,
    escapeQuotesDetectingNewlines,
  );
  let outputString = `'${escapedString}'`;
  if (crs) outputString = `replace(${outputString},'\\r',char(13))`;
  if (lfs) outputString = `replace(${outputString},'\\n',char(10))`;
  return outputString;
}

/** Escape an identifier for use in SQL statements. */
function escapeId(id: string) {
  return `"${id.replace(/"/g, '""')}"`;
}
