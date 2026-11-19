import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  IssueTrackerAccountId,
  IssueTrackerKind,
  IssueTrackerProjectBinding,
  ProjectId,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const BindingRow = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  accountId: Schema.NullOr(IssueTrackerAccountId),
  scope: Schema.String,
  additionalScopes: Schema.fromJsonString(Schema.Array(Schema.String)),
});

const AccountRow = Schema.Struct({
  tracker: IssueTrackerKind,
  accountId: IssueTrackerAccountId,
});

/**
 * Which standalone issue tracker scopes each project reads beside its git host's own issues. A
 * project is bound to one tracker at most, and only while it has a row.
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
    /**
     * Unbinds every project that pointed at one account, when its credential is removed, and
     * forgets an added account. A null account is the tracker's first, which has no row.
     */
    readonly removeAccount: (input: {
      readonly tracker: IssueTrackerKind;
      readonly accountId: IssueTrackerAccountId | null;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** The accounts added beside each tracker's first, oldest first. */
    readonly listAccounts: Effect.Effect<
      ReadonlyArray<{
        readonly tracker: IssueTrackerKind;
        readonly accountId: IssueTrackerAccountId;
      }>,
      IssueTrackerBindingsRepositoryError
    >;
    readonly addAccount: (input: {
      readonly tracker: IssueTrackerKind;
      readonly accountId: IssueTrackerAccountId;
      /** When the account was added, as an ISO instant. */
      readonly createdAt: string;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
  }
>()("t3/persistence/IssueTrackerBindings/IssueTrackerBindingsRepository") {}

const encodeAdditionalScopes = Schema.encodeEffect(BindingRow.fields.additionalScopes);

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
        SELECT project_id AS "projectId", tracker AS "tracker", account_id AS "accountId",
          scope AS "scope", additional_scopes AS "additionalScopes"
        FROM issue_tracker_bindings
      `,
  });

  const listAccountRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AccountRow,
    execute: () =>
      sql`
        SELECT tracker AS "tracker", account_id AS "accountId"
        FROM issue_tracker_accounts
        ORDER BY created_at, account_id
      `,
  });

  return IssueTrackerBindingsRepository.of({
    list: listRows(undefined).pipe(
      Effect.map(
        (rows) =>
          new Map(
            rows.map(
              ({ projectId, accountId, additionalScopes, ...binding }) =>
                [
                  projectId,
                  {
                    ...binding,
                    ...(accountId === null ? {} : { accountId }),
                    ...(additionalScopes.length === 0 ? {} : { additionalScopes }),
                  },
                ] as const,
            ),
          ),
      ),
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
    ),
    set: Effect.fn("IssueTrackerBindingsRepository.set")(
      function* (input) {
        if (input.binding === null) {
          yield* sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId}`;
          return;
        }
        const additionalScopes = yield* encodeAdditionalScopes(
          input.binding.additionalScopes ?? [],
        );
        yield* sql`
              INSERT INTO issue_tracker_bindings (project_id, tracker, account_id, scope, additional_scopes, updated_at)
              VALUES (
                ${input.projectId}, ${input.binding.tracker}, ${input.binding.accountId ?? null},
                ${input.binding.scope}, ${additionalScopes}, ${input.updatedAt}
              )
              ON CONFLICT (project_id)
              DO UPDATE SET tracker = excluded.tracker, account_id = excluded.account_id,
                scope = excluded.scope, additional_scopes = excluded.additional_scopes,
                updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(toSqlOrDecodeError("setIssueTrackerBinding", "IssueTrackerBinding")),
    ),
    removeAccount: Effect.fn("IssueTrackerBindingsRepository.removeAccount")(
      function* ({ tracker, accountId }) {
        yield* sql.withTransaction(
          accountId === null
            ? sql`DELETE FROM issue_tracker_bindings WHERE tracker = ${tracker} AND account_id IS NULL`
            : Effect.andThen(
                sql`DELETE FROM issue_tracker_bindings WHERE tracker = ${tracker} AND account_id = ${accountId}`,
                sql`DELETE FROM issue_tracker_accounts WHERE tracker = ${tracker} AND account_id = ${accountId}`,
              ),
        );
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerAccount", cause }),
      ),
    ),
    listAccounts: listAccountRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerAccounts", "IssueTrackerAccount")),
    ),
    addAccount: Effect.fn("IssueTrackerBindingsRepository.addAccount")(
      function* (input) {
        yield* sql`
          INSERT INTO issue_tracker_accounts (tracker, account_id, created_at)
          VALUES (${input.tracker}, ${input.accountId}, ${input.createdAt})
        `;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "addIssueTrackerAccount", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueTrackerBindingsRepository, make);
