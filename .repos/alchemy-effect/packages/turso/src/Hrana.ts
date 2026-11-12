import { MigrationError, type SqlExecutor } from "@alchemy.run/sql/Migrations";
import { splitSqlStatements } from "@alchemy.run/sql/SqlFile";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";

/**
 * A minimal Hrana-over-HTTP client (`POST /v2/pipeline`) — the SQL wire
 * protocol every Turso database speaks. Deploy-time work (migrations, SQL
 * imports) uses it instead of `@libsql/client`, so the provider needs no
 * driver and runs anywhere `HttpClient` does.
 *
 * @see https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
 */
export class HranaError extends Data.TaggedError("Turso::HranaError")<{
  message: string;
  code?: string;
  cause?: unknown;
}> {}

type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

interface HranaStmt {
  sql: string;
  args?: HranaValue[];
}

interface HranaExecuteResult {
  cols: Array<{ name: string | null }>;
  rows: HranaValue[][];
}

interface HranaError_ {
  message: string;
  code?: string;
}

interface PipelineResponse {
  results: Array<
    | { type: "ok"; response: { type: string; result?: unknown } }
    | { type: "error"; error: HranaError_ }
  >;
}

const toHranaValue = (value: unknown): HranaValue => {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: value.toString() }
      : { type: "float", value };
  }
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Date) return { type: "text", value: value.toISOString() };
  return { type: "text", value: JSON.stringify(value) };
};

const fromHranaValue = (value: HranaValue): unknown => {
  switch (value.type) {
    case "null":
      return null;
    case "integer":
      return Number(value.value);
    case "float":
      return value.value;
    case "text":
      return value.value;
    case "blob":
      return Buffer.from(value.base64, "base64");
  }
};

const toRows = (result: HranaExecuteResult): Array<Record<string, unknown>> =>
  result.rows.map((row) =>
    Object.fromEntries(
      result.cols.map((col, i) => [col.name ?? String(i), fromHranaValue(row[i]!)]),
    ),
  );

/** Connection details for one Turso database. */
export interface HranaConnection {
  /** `https://<hostname>` of the database. */
  url: string;
  /** A database auth token (JWT). */
  authToken: Redacted.Redacted<string>;
}

const pipeline = (connection: HranaConnection, requests: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${connection.url.replace(/\/$/, "")}/v2/pipeline`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(connection.authToken)),
          HttpClientRequest.bodyJsonUnsafe({ requests: [...requests, { type: "close" }] }),
        ),
      )
      .pipe(Effect.mapError((cause) => new HranaError({ message: String(cause), cause })));
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new HranaError({
        message: `Turso SQL request failed with HTTP ${response.status}: ${text}`,
      });
    }
    const body = (yield* response.json.pipe(
      Effect.mapError((cause) => new HranaError({ message: String(cause), cause })),
    )) as unknown as PipelineResponse;
    return body.results.slice(0, requests.length);
  });

/** Execute one statement and return its rows as objects. */
export const query = (
  connection: HranaConnection,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Effect.Effect<Array<Record<string, unknown>>, HranaError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const stmt: HranaStmt = { sql, args: (params ?? []).map(toHranaValue) };
    const [result] = yield* pipeline(connection, [{ type: "execute", stmt }]);
    if (result === undefined) {
      return yield* new HranaError({ message: "Turso returned no result" });
    }
    if (result.type === "error") {
      return yield* new HranaError({ message: result.error.message, code: result.error.code });
    }
    return toRows(result.response.result as HranaExecuteResult);
  });

/**
 * Execute statements atomically. Each entry may hold several
 * `;`-separated statements (a whole migration file or seed script), so they
 * run as one Hrana `sequence` wrapped in `BEGIN`/`COMMIT`. A failing
 * statement stops the sequence before `COMMIT`, and closing the stream
 * rolls the open transaction back.
 */
export const transaction = (
  connection: HranaConnection,
  statements: ReadonlyArray<string>,
): Effect.Effect<void, HranaError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const body = statements.flatMap(splitSqlStatements);
    if (body.length === 0) return;
    const sql = ["BEGIN", ...body.map((s) => s.replace(/;\s*$/, "")), "COMMIT"].join(";\n");
    const [result] = yield* pipeline(connection, [{ type: "sequence", sql }]);
    if (result === undefined) {
      return yield* new HranaError({ message: "Turso returned no result" });
    }
    if (result.type === "error") {
      return yield* new HranaError({ message: result.error.message, code: result.error.code });
    }
  });

/** Adapt a Turso database connection into the migration registry's executor. */
export const makeMigrationExecutor = (
  connection: HranaConnection,
  client: HttpClient.HttpClient,
): SqlExecutor => {
  const toMigrationError = (error: HranaError) =>
    new MigrationError({ message: `turso: ${error.message}`, cause: error });
  return {
    dialect: "sqlite",
    query: (sql, params) =>
      query(connection, sql, params).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError(toMigrationError),
      ),
    batch: (statements) =>
      transaction(connection, statements).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.mapError(toMigrationError),
      ),
  };
};
