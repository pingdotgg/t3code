import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import KeyspacesRestoreTestFunctionLive, {
  KeyspacesRestoreTestFunction,
} from "./restore-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const RESTORE_KS = "alchemy_restore_test_ks";
const RESTORED_TABLE = "orders_restored";

// The restored table is created out-of-band by the Lambda (RestoreTable
// provisions a brand-new table), so the test owns its cleanup. A table that
// is still RESTORING rejects delete with ConflictException; retry bounded.
const deleteRestoredTable = keyspaces
  .deleteTable({ keyspaceName: RESTORE_KS, tableName: RESTORED_TABLE })
  .pipe(
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e): boolean => e._tag === "ConflictException",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(36),
      ]),
    }),
    // Wait (bounded) until it is actually gone so the keyspace can be
    // destroyed without a ConflictException.
    Effect.andThen(
      keyspaces
        .getTable({ keyspaceName: RESTORE_KS, tableName: RESTORED_TABLE })
        .pipe(
          Effect.flatMap(() =>
            Effect.fail(new Error(`'${RESTORED_TABLE}' still deleting`)),
          ),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(20),
            ]),
          }),
        ),
    ),
  );

// keyspaces RestoreTable creates a new table from a source table's
// point-in-time-recovery backup. The ungated probe asserts the distilled
// wiring surfaces typed errors; the live restore (which needs a PITR table +
// a deployed Lambda exercising the RestoreTable binding) is gated behind
// AWS_TEST_SLOW=1.
describe("AWS.Keyspaces.RestoreTable", () => {
  test.provider(
    "restore of a nonexistent source table yields a typed error",
    (_stack) =>
      Effect.gen(function* () {
        const error = yield* keyspaces
          .restoreTable({
            sourceKeyspaceName: "alchemy_nonexistent_ks",
            sourceTableName: "nonexistent_tbl",
            targetKeyspaceName: "alchemy_nonexistent_ks",
            targetTableName: "restored_tbl",
          })
          .pipe(Effect.flip);
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          error._tag,
        );
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "Lambda restores a PITR table into a new table via the binding",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { functionUrl } = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* KeyspacesRestoreTestFunction;
          }).pipe(Effect.provide(KeyspacesRestoreTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        // Pre-clean any restored table left over from a previous failed run
        // — RestoreTable rejects when the target already exists.
        yield* deleteRestoredTable;

        // Drive the deployed Lambda through the RestoreTable binding —
        // proves the cassandra:Restore/Select IAM actions and the client
        // wiring. Retry through function-URL cold start / IAM propagation.
        const body = yield* HttpClient.post(`${baseUrl}/restore`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`restore not ready: ${response.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(8),
            ]),
          }),
        );
        const restored = body as { restoredTableARN?: string; error?: string };
        expect(restored.error).toBeUndefined();
        expect(restored.restoredTableARN).toContain(
          `/keyspace/${RESTORE_KS}/table/${RESTORED_TABLE}`,
        );

        // Out-of-band cleanup of the restored table, then tear down the
        // stack-managed keyspace/table/function.
        yield* deleteRestoredTable;
        yield* stack.destroy();
      }).pipe(Effect.ensuring(Effect.ignore(deleteRestoredTable))),
    { timeout: 900_000 },
  );
});
