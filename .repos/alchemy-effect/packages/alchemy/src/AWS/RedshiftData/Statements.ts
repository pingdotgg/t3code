import type * as data from "@distilled.cloud/aws/redshift-data";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workgroup } from "../RedshiftServerless/Workgroup.ts";

/**
 * Options that pin every statement run through this binding to a database and,
 * optionally, an authentication method.
 */
export interface StatementsOptions {
  /**
   * Database to run statements against.
   * @default "dev"
   */
  database?: string;
  /**
   * ARN of a Secrets Manager secret holding the database credentials. Omit to
   * authenticate with the Lambda's IAM identity via
   * `redshift-serverless:GetCredentials`.
   */
  secretArn?: string;
  /**
   * Database user to connect as. Only used with secret/temporary-credential
   * auth flows that require an explicit user.
   */
  dbUser?: string;
}

/**
 * Fields the binding injects on every request: the workgroup, the pinned
 * database, and the auth fields resolved from {@link StatementsOptions}
 * (cluster-only fields are excluded because this binding targets Serverless).
 */
type InjectedFields =
  | "WorkgroupName"
  | "Database"
  | "ClusterIdentifier"
  | "SecretArn"
  | "DbUser";

/**
 * `executeStatement` input minus the identifiers this binding injects
 * (workgroup, database, and the cluster-only fields).
 */
export interface ExecuteStatementRequest extends Omit<
  data.ExecuteStatementInput,
  InjectedFields
> {}

/**
 * `batchExecuteStatement` input minus the identifiers this binding injects
 * (workgroup, database, and the cluster-only fields).
 */
export interface BatchExecuteStatementRequest extends Omit<
  data.BatchExecuteStatementInput,
  InjectedFields
> {}

/**
 * `describeTable` input minus the injected identifiers. Use
 * `ConnectedDatabase` to introspect a database other than the pinned one.
 */
export interface DescribeTableRequest extends Omit<
  data.DescribeTableRequest,
  InjectedFields
> {}

/**
 * `listDatabases` input minus the injected identifiers.
 */
export interface ListDatabasesRequest extends Omit<
  data.ListDatabasesRequest,
  InjectedFields
> {}

/**
 * `listSchemas` input minus the injected identifiers.
 */
export interface ListSchemasRequest extends Omit<
  data.ListSchemasRequest,
  InjectedFields
> {}

/**
 * `listTables` input minus the injected identifiers.
 */
export interface ListTablesRequest extends Omit<
  data.ListTablesRequest,
  InjectedFields
> {}

/**
 * `listStatements` input minus the workgroup identifier this binding injects.
 * `Database`, `Status`, and `StatementName` remain available as filters.
 */
export interface ListStatementsRequest extends Omit<
  data.ListStatementsRequest,
  "ClusterIdentifier" | "WorkgroupName"
> {}

/**
 * Raised when a statement reaches a terminal `FAILED` or `ABORTED` status
 * while a composite `query` waits for it to finish.
 */
export class RedshiftStatementFailed extends Data.TaggedError(
  "RedshiftStatementFailed",
)<{
  /**
   * ID of the failed statement.
   */
  readonly statementId: string;
  /**
   * Terminal status the statement ended in (`"FAILED"` or `"ABORTED"`).
   */
  readonly status: string;
  /**
   * Error message reported by Redshift, if any.
   */
  readonly error: string | undefined;
}> {}

/**
 * Runtime client for the Redshift Data API scoped to a single workgroup +
 * database.
 */
export interface StatementsClient {
  /**
   * Submit a SQL statement. Returns immediately with the statement `Id`;
   * results are fetched asynchronously via {@link describe}/{@link getResult}.
   */
  readonly execute: (
    request: ExecuteStatementRequest,
  ) => Effect.Effect<data.ExecuteStatementOutput, data.ExecuteStatementError>;
  /**
   * Submit a batch of SQL statements that run in order as one transaction.
   * Returns immediately with the batch statement `Id`; sub-statement ids
   * (`{Id}:1`, `{Id}:2`, ...) are reported by {@link describe}.
   */
  readonly executeBatch: (
    request: BatchExecuteStatementRequest,
  ) => Effect.Effect<
    data.BatchExecuteStatementOutput,
    data.BatchExecuteStatementError
  >;
  /**
   * Describe a submitted statement (status, timing, row counts).
   */
  readonly describe: (
    id: string,
  ) => Effect.Effect<
    data.DescribeStatementResponse,
    data.DescribeStatementError
  >;
  /**
   * Cancel a running statement. Returns `Status: true` when the cancellation
   * was accepted.
   */
  readonly cancel: (
    id: string,
  ) => Effect.Effect<data.CancelStatementResponse, data.CancelStatementError>;
  /**
   * Fetch the cached result rows of a finished statement (JSON result
   * format). Pass `nextToken` to page through large result sets.
   */
  readonly getResult: (
    id: string,
    nextToken?: string,
  ) => Effect.Effect<
    data.GetStatementResultResponse,
    data.GetStatementResultError
  >;
  /**
   * Fetch the cached result rows of a finished statement that ran with
   * `ResultFormat: "CSV"`. Pass `nextToken` to page through large result
   * sets.
   */
  readonly getResultV2: (
    id: string,
    nextToken?: string,
  ) => Effect.Effect<
    data.GetStatementResultV2Response,
    data.GetStatementResultV2Error
  >;
  /**
   * Describe a table's columns from the database metadata.
   */
  readonly describeTable: (
    request: DescribeTableRequest,
  ) => Effect.Effect<data.DescribeTableResponse, data.DescribeTableError>;
  /**
   * List the databases in the workgroup.
   */
  readonly listDatabases: (
    request?: ListDatabasesRequest,
  ) => Effect.Effect<data.ListDatabasesResponse, data.ListDatabasesError>;
  /**
   * List the schemas in the pinned database.
   */
  readonly listSchemas: (
    request?: ListSchemasRequest,
  ) => Effect.Effect<data.ListSchemasResponse, data.ListSchemasError>;
  /**
   * List the tables in the pinned database, optionally filtered by
   * `SchemaPattern`/`TablePattern`.
   */
  readonly listTables: (
    request?: ListTablesRequest,
  ) => Effect.Effect<data.ListTablesResponse, data.ListTablesError>;
  /**
   * List statements previously run through the Data API on this workgroup
   * by the caller's identity.
   */
  readonly listStatements: (
    request?: ListStatementsRequest,
  ) => Effect.Effect<data.ListStatementsResponse, data.ListStatementsError>;
  /**
   * Run a SQL statement and wait (bounded) for it to finish, returning its
   * result rows. Fails with {@link RedshiftStatementFailed} if the statement
   * ends in `FAILED`/`ABORTED`.
   */
  readonly query: (
    sql: string,
    parameters?: data.SqlParameter[],
  ) => Effect.Effect<
    data.GetStatementResultResponse,
    | data.ExecuteStatementError
    | data.DescribeStatementError
    | data.GetStatementResultError
    | RedshiftStatementFailed
  >;
}

/**
 * Runtime binding for the Amazon Redshift Data API against a Serverless
 * {@link Workgroup}. Exposes the full Data API surface —
 * `execute`/`executeBatch`/`describe`/`cancel`/`getResult`/`getResultV2`,
 * the metadata reads (`describeTable`, `listDatabases`, `listSchemas`,
 * `listTables`, `listStatements`) — plus a composite `query` that submits a
 * statement and polls until it finishes.
 *
 * At deploy time it grants the workgroup-scoped Data API actions on the
 * workgroup (plus `redshift-serverless:GetCredentials` for IAM auth) and the
 * statement-scoped actions (`DescribeStatement`, `GetStatementResult`,
 * `GetStatementResultV2`, `CancelStatement`, `ListStatements`) which AWS
 * authorizes per statement owner rather than by ARN. The Data API is
 * HTTP-based — no driver, no VPC reach, and no credential plumbing required.
 * Provide the implementation with
 * `Effect.provide(AWS.RedshiftData.StatementsHttp)`.
 *
 * @binding
 * @section Running SQL
 * @example Query a Workgroup
 * ```typescript
 * const sql = yield* RedshiftData.Statements(workgroup, { database: "dev" });
 * const result = yield* sql.query("SELECT 1 AS n");
 * // result.Records -> [[{ longValue: 1 }]]
 * ```
 *
 * @example Run a Batch of Statements in One Transaction
 * ```typescript
 * const submitted = yield* sql.executeBatch({
 *   Sqls: ["CREATE TABLE IF NOT EXISTS events(id int)", "INSERT INTO events VALUES (1)"],
 * });
 * // sub-statement ids are `${submitted.Id}:1`, `${submitted.Id}:2`
 * const described = yield* sql.describe(submitted.Id!);
 * ```
 *
 * @example Cancel a Running Statement
 * ```typescript
 * const submitted = yield* sql.execute({ Sql: "SELECT count(*) FROM big_table" });
 * const { Status } = yield* sql.cancel(submitted.Id!);
 * ```
 *
 * @section Browsing Metadata
 * @example List Databases, Schemas and Tables
 * ```typescript
 * const { Databases } = yield* sql.listDatabases();
 * const { Schemas } = yield* sql.listSchemas({ SchemaPattern: "public" });
 * const { Tables } = yield* sql.listTables({ SchemaPattern: "public" });
 * const { ColumnList } = yield* sql.describeTable({ Schema: "public", Table: "events" });
 * ```
 *
 * @example Serve Query Results from a Lambda Function
 * ```typescript
 * export default QueryFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const namespace = yield* RedshiftServerless.Namespace("Analytics", {
 *       dbName: "analytics",
 *       adminUsername: "admin",
 *       manageAdminPassword: true,
 *     });
 *     const workgroup = yield* RedshiftServerless.Workgroup("Analytics", {
 *       namespaceName: namespace.namespaceName,
 *       baseCapacity: 8,
 *     });
 *     // init — bind the Data API to the workgroup
 *     const sql = yield* RedshiftData.Statements(workgroup, {
 *       database: "analytics",
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — submit a statement and wait for its rows
 *         const result = yield* sql.query("SELECT count(*) AS n FROM events");
 *         return yield* HttpServerResponse.json({ records: result.Records });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(RedshiftData.StatementsHttp)),
 * );
 * ```
 */
export interface Statements extends Binding.Service<
  Statements,
  "AWS.RedshiftData.Statements",
  (
    workgroup: Workgroup,
    options?: StatementsOptions,
  ) => Effect.Effect<StatementsClient>
> {}

export const Statements = Binding.Service<Statements>(
  "AWS.RedshiftData.Statements",
);
