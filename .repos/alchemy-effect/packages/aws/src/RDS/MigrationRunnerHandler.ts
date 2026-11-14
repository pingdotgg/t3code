import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { withMigrationConnection, type MigrationConnectionTarget } from "./MigrationConnection.ts";

/**
 * One SQL operation the deploying machine asks the in-VPC runner to perform.
 * `batch` runs its statements in one transaction.
 */
export type MigrationRunnerRequest =
  | { op: "query"; target: MigrationConnectionTarget; sql: string }
  | { op: "batch"; target: MigrationConnectionTarget; statements: ReadonlyArray<string> };

export type MigrationRunnerResponse =
  | { ok: true; rows: Array<Record<string, unknown>> }
  | { ok: false; message: string };

/**
 * Entry point of the `AWS.RDS.MigrationRunner` Lambda. Each invocation
 * opens one connection, runs one query or one transactional batch, and
 * closes the connection. Failures return `{ ok: false }` so the deploying
 * machine reports the database's own error message.
 */
export const handler = async (event: MigrationRunnerRequest): Promise<MigrationRunnerResponse> => {
  const exit = await Effect.runPromiseExit(
    withMigrationConnection(event.target, (executor) =>
      event.op === "query"
        ? executor.query(event.sql)
        : executor.batch(event.statements).pipe(Effect.as([])),
    ),
  );
  if (Exit.isSuccess(exit)) return { ok: true, rows: exit.value };
  const error = Cause.squash(exit.cause);
  return { ok: false, message: error instanceof Error ? error.message : Cause.pretty(exit.cause) };
};
