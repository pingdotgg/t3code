import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForLongRunning, type LongRunningOperation } from "../Operation.ts";

// A display-name clash ("App with display name … already exists") also reports
// ALREADY_EXISTS but means our resource was never created, so it must fail.

/** CES app and agent operations finish within a few minutes. */
const OPERATION_BUDGET = "10 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(operation, (name) => ces.getProjectsLocationsOperations({ name }), {
    budget: OPERATION_BUDGET,
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
export const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" || (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
