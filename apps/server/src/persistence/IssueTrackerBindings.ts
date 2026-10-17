import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  IssueTrackerKind,
  IssueTrackerProjectBinding,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const BindingRow = Schema.Struct({
  projectId: ProjectId,
  tracker: Schema.Union([
    IssueTrackerKind,
    Schema.fromJsonString(
      Schema.Struct({
        tracker: IssueTrackerKind,
        connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      }),
    ),
  ]),
  nativeTracker: IssueTrackerKind,
  scope: Schema.String,
  host: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((row) =>
    typeof row.tracker === "string"
      ? row.tracker === row.nativeTracker && row.connectionId === null
      : row.tracker.tracker === row.nativeTracker && row.tracker.connectionId === row.connectionId,
  ),
);

/**
 * Which standalone issue tracker scope each project reads beside its git host's own issues. A
 * project is bound to one scope per tracker, and only while it has a row.
 */
export class IssueTrackerBindingsRepository extends Context.Service<
  IssueTrackerBindingsRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyMap<ProjectId, ReadonlyArray<IssueTrackerProjectBinding>>,
      IssueTrackerBindingsRepositoryError
    >;
    /** Null unbinds. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly binding: IssueTrackerProjectBinding | null;
      readonly tracker?: IssueTrackerKind | undefined;
      /** When the binding was saved, as an ISO instant. */
      readonly updatedAt: string;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** Unbinds projects that pointed at the selected account when its credential is removed. */
    readonly removeTracker: (
      tracker: IssueTrackerKind,
      connectionId?: string | undefined,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
  }
>()("t3/persistence/IssueTrackerBindings/IssueTrackerBindingsRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): IssueTrackerBindingsRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BindingRow,
    execute: () =>
      sql`
        SELECT project_id AS "projectId", tracker, native_tracker AS "nativeTracker", scope, host, connection_id AS "connectionId"
        FROM issue_tracker_bindings ORDER BY project_id, native_tracker
      `,
  });

  return IssueTrackerBindingsRepository.of({
    list: listRows(undefined).pipe(
      Effect.map((rows) => {
        const grouped = new Map<ProjectId, IssueTrackerProjectBinding[]>();
        for (const row of rows) {
          const bindings = grouped.get(row.projectId) ?? [];
          bindings.push({
            tracker: row.nativeTracker,
            scope: row.scope,
            ...(row.host === null ? {} : { host: row.host }),
            ...(row.connectionId === null ? {} : { connectionId: row.connectionId }),
          });
          grouped.set(row.projectId, bindings);
        }
        return grouped;
      }),
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
    ),
    set: (input) =>
      (input.binding === null
        ? input.tracker === undefined
          ? sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId}`
          : sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId} AND native_tracker = ${input.tracker}`
        : sql`
            INSERT INTO issue_tracker_bindings (project_id, tracker, native_tracker, scope, host, connection_id, updated_at)
            VALUES (${input.projectId}, ${input.binding.connectionId === undefined ? input.binding.tracker : JSON.stringify({ tracker: input.binding.tracker, connectionId: input.binding.connectionId })}, ${input.binding.tracker}, ${input.binding.scope}, ${input.binding.host ?? null}, ${input.binding.connectionId ?? null}, ${input.updatedAt})
            ON CONFLICT (project_id, native_tracker)
            DO UPDATE SET tracker = excluded.tracker, scope = excluded.scope, host = excluded.host, connection_id = excluded.connection_id, updated_at = excluded.updated_at
          `
      ).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "setIssueTrackerBinding", cause }),
        ),
      ),
    removeTracker: (tracker, connectionId) =>
      sql`DELETE FROM issue_tracker_bindings WHERE native_tracker = ${tracker} AND connection_id IS ${connectionId ?? null}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerBindings", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(IssueTrackerBindingsRepository, make);
