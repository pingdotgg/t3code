#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - node:os resolves the shared T3 home guard.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Argument, Command, Flag } from "effect/unstable/cli";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

export const SqliteStateOperation = Schema.Literals(["query", "exec"]);
export type SqliteStateOperation = typeof SqliteStateOperation.Type;

export class SqliteStateMultipleSqlSourcesError extends Schema.TaggedErrorClass<SqliteStateMultipleSqlSourcesError>()(
  "SqliteStateMultipleSqlSourcesError",
  {},
) {
  override get message(): string {
    return "Provide only one of --sql or --file.";
  }
}

export class SqliteStateMissingSqlSourceError extends Schema.TaggedErrorClass<SqliteStateMissingSqlSourceError>()(
  "SqliteStateMissingSqlSourceError",
  {},
) {
  override get message(): string {
    return "Provide one of --sql or --file.";
  }
}

export class SqliteStateEmptySqlError extends Schema.TaggedErrorClass<SqliteStateEmptySqlError>()(
  "SqliteStateEmptySqlError",
  {},
) {
  override get message(): string {
    return "SQL input is empty.";
  }
}

export class SqliteStateDatabaseMissingError extends Schema.TaggedErrorClass<SqliteStateDatabaseMissingError>()(
  "SqliteStateDatabaseMissingError",
  {
    databasePath: Schema.String,
  },
) {
  override get message(): string {
    return `Database does not exist at '${this.databasePath}'. Start T3 once to run migrations.`;
  }
}

export class SqliteStateSharedHomeMutationError extends Schema.TaggedErrorClass<SqliteStateSharedHomeMutationError>()(
  "SqliteStateSharedHomeMutationError",
  {},
) {
  override get message(): string {
    return "Refusing to mutate the shared ~/.t3 database. Use an isolated --base-dir.";
  }
}

export class SqliteStateSqlFileError extends Schema.TaggedErrorClass<SqliteStateSqlFileError>()(
  "SqliteStateSqlFileError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read SQL from '${this.filePath}'.`;
  }
}

export class SqliteStateDatabaseError extends Schema.TaggedErrorClass<SqliteStateDatabaseError>()(
  "SqliteStateDatabaseError",
  {
    operation: SqliteStateOperation,
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} SQLite database at '${this.databasePath}'.`;
  }
}

const SqliteStateValue = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Number,
  Schema.Array(Schema.Number),
]);
const SqliteStateRow = Schema.Record(Schema.String, SqliteStateValue);
const SqliteStateQueryResult = Schema.Struct({
  operation: Schema.Literal("query"),
  database: Schema.String,
  rows: Schema.Array(SqliteStateRow),
});
const SqliteStateExecResult = Schema.Struct({
  operation: Schema.Literal("exec"),
  database: Schema.String,
  backup: Schema.String,
});
const SqliteStateResult = Schema.Union([SqliteStateQueryResult, SqliteStateExecResult]);
const encodeSqliteStateResult = Schema.encodeEffect(fromJsonStringPretty(SqliteStateResult));

export type SqliteStateResult = typeof SqliteStateResult.Type;

type RawSqliteValue = null | string | number | bigint | Uint8Array;
type RawSqliteRow = Readonly<Record<string, RawSqliteValue>>;

export interface RunSqliteStateInput {
  readonly operation: SqliteStateOperation;
  readonly baseDir: string;
  readonly sql?: string | undefined;
  readonly file?: string | undefined;
}

export interface RunSqliteStateOptions {
  readonly sharedHome?: string | undefined;
}

const resolveSqlSource = Effect.fn("resolveSqliteStateSqlSource")(function* (
  sql: string | undefined,
  file: string | undefined,
) {
  if (sql !== undefined && file !== undefined) {
    return yield* new SqliteStateMultipleSqlSourcesError();
  }
  if (sql === undefined && file === undefined) {
    return yield* new SqliteStateMissingSqlSourceError();
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let source: string;
  if (sql !== undefined) {
    source = sql;
  } else {
    const filePath = path.resolve(file as string);
    source = yield* fs
      .readFileString(filePath)
      .pipe(Effect.mapError((cause) => new SqliteStateSqlFileError({ filePath, cause })));
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return yield* new SqliteStateEmptySqlError();
  }
  return trimmed;
});

function normalizeSqliteValue(value: RawSqliteValue): typeof SqliteStateValue.Type {
  if (typeof value === "bigint") {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) ? numericValue : value.toString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  return value;
}

function normalizeSqliteRow(row: RawSqliteRow): typeof SqliteStateRow.Type {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqliteValue(value)]),
  );
}

export const runSqliteState = Effect.fn("runSqliteState")(function* (
  input: RunSqliteStateInput,
  options: RunSqliteStateOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.resolve(input.baseDir);
  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const databasePath = path.join(baseDir, "userdata", "state.sqlite");
  const source = yield* resolveSqlSource(input.sql, input.file);

  if (!(yield* fs.exists(databasePath))) {
    return yield* new SqliteStateDatabaseMissingError({ databasePath });
  }
  if (input.operation === "exec") {
    const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
      fs.realPath(baseDir),
      fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
    ]);
    if (canonicalBaseDir === canonicalSharedHome) {
      return yield* new SqliteStateSharedHomeMutationError();
    }
  }

  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 5000").unprepared;

    if (input.operation === "query") {
      const rows = yield* sql.unsafe<RawSqliteRow>(source).unprepared.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        Effect.map((rows) => rows.map(normalizeSqliteRow)),
      );
      return {
        operation: "query",
        database: databasePath,
        rows,
      } as const;
    }

    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const backupPath = `${databasePath}.backup-${timestamp}`;
    yield* sql`VACUUM INTO ${backupPath}`;
    yield* fs.chmod(backupPath, 0o600);
    yield* sql.withTransaction(sql.unsafe(source).unprepared);

    return {
      operation: "exec",
      database: databasePath,
      backup: backupPath,
    } as const;
  });

  return yield* program.pipe(
    Effect.provide(
      NodeSqliteClient.layer({
        filename: databasePath,
        readonly: input.operation === "query",
      }),
    ),
    Effect.mapError(
      (cause) =>
        new SqliteStateDatabaseError({
          operation: input.operation,
          databasePath,
          cause,
        }),
    ),
  );
});

export const t3SqliteStateCommand = Command.make(
  "t3-sqlite-state",
  {
    operation: Argument.choice("operation", SqliteStateOperation.literals).pipe(
      Argument.withDescription("Run a read-only query or a backed-up fixture mutation."),
    ),
    baseDir: Flag.string("base-dir").pipe(
      Flag.withDescription("Explicit T3 base directory containing userdata/state.sqlite."),
    ),
    sql: Flag.string("sql").pipe(
      Flag.optional,
      Flag.withDescription("SQL source supplied directly on the command line."),
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Path to a SQL source file."),
    ),
  },
  ({ operation, baseDir, sql, file }) =>
    runSqliteState({
      operation,
      baseDir,
      sql: Option.getOrUndefined(sql),
      file: Option.getOrUndefined(file),
    }).pipe(Effect.flatMap(encodeSqliteStateResult), Effect.flatMap(Console.log)),
).pipe(
  Command.withDescription(
    "Inspect or seed an isolated T3 SQLite database with automatic backups for writes.",
  ),
);

if (import.meta.main) {
  Command.run(t3SqliteStateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
