import * as ccaip from "@distilled.cloud/gcp/contactcenteraiplatform_v1alpha1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForLongRunning, type LongRunningOperation } from "../Operation.ts";

/** Contact center instance provisioning takes 30–45 minutes. */
const OPERATION_BUDGET = "60 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(operation, (name) => ccaip.getProjectsLocationsOperations({ name }), {
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
