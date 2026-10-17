import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { IssueTrackerKind, TrimmedNonEmptyString } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const Account = Schema.Struct({
  tracker: IssueTrackerKind,
  connectionId: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
});

export class IssueTrackerAccountsRepository extends Context.Service<
  IssueTrackerAccountsRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<typeof Account.Type>,
      IssueTrackerBindingsRepositoryError
    >;
    readonly set: (
      account: typeof Account.Type,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    readonly remove: (
      tracker: IssueTrackerKind,
      connectionId: string,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
  }
>()("t3/persistence/IssueTrackerAccounts/IssueTrackerAccountsRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Account,
    execute: () =>
      sql`SELECT tracker, connection_id AS "connectionId", host, account_id AS "accountId" FROM issue_tracker_accounts ORDER BY tracker, connection_id`,
  });
  return IssueTrackerAccountsRepository.of({
    list: rows(undefined).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("IssueTrackerAccounts", cause)
          : new PersistenceSqlError({ operation: "listIssueTrackerAccounts", cause }),
      ),
    ),
    set: (account) =>
      sql`INSERT INTO issue_tracker_accounts (tracker, connection_id, host, account_id)
      VALUES (${account.tracker}, ${account.connectionId}, ${account.host}, ${account.accountId})`.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "setIssueTrackerAccount", cause }),
        ),
      ),
    remove: (tracker, connectionId) =>
      sql`DELETE FROM issue_tracker_accounts WHERE tracker = ${tracker} AND connection_id = ${connectionId}`.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerAccount", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(IssueTrackerAccountsRepository, make);
