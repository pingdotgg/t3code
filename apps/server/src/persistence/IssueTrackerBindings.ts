import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { IssueTrackerKind, IssueTrackerProjectBinding, ProjectId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const BindingRow = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  scope: Schema.String,
});

/**
 * Which standalone issue tracker scope each project reads beside its git host's own issues. A
 * project is bound to one scope at most, and only while it has a row.
 */
export class IssueTrackerBindingsRepository extends Context.Service<
  IssueTrackerBindingsRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyMap<ProjectId, IssueTrackerProjectBinding>,
      IssueTrackerBindingsRepositoryError
    >;
    /** Null unbinds. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly binding: IssueTrackerProjectBinding | null;
      /** When the binding was saved, as an ISO instant. */
      readonly updatedAt: string;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** Unbinds every project that pointed at the tracker, when its credential is removed. */
    readonly removeTracker: (
      tracker: IssueTrackerKind,
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
        SELECT project_id AS "projectId", tracker AS "tracker", scope AS "scope"
        FROM issue_tracker_bindings
      `,
  });

  return IssueTrackerBindingsRepository.of({
    list: listRows(undefined).pipe(
      Effect.map(
        (rows) =>
          new Map(
            rows.map((row) => [row.projectId, { tracker: row.tracker, scope: row.scope }] as const),
          ),
      ),
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
    ),
    set: (input) =>
      (input.binding === null
        ? sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId}`
        : sql`
            INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at)
            VALUES (${input.projectId}, ${input.binding.tracker}, ${input.binding.scope}, ${input.updatedAt})
            ON CONFLICT (project_id)
            DO UPDATE SET tracker = excluded.tracker, scope = excluded.scope, updated_at = excluded.updated_at
          `
      ).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "setIssueTrackerBinding", cause }),
        ),
      ),
    removeTracker: (tracker) =>
      sql`DELETE FROM issue_tracker_bindings WHERE tracker = ${tracker}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerBindings", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(IssueTrackerBindingsRepository, make);
