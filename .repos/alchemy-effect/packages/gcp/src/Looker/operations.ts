import * as looker from "@distilled.cloud/gcp/looker_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/**
 * Wait for a Looker operation; instance backups take several minutes.
 * ALREADY_EXISTS (code 6) counts as success (create race); with
 * `notFoundOk`, so does NOT_FOUND (code 5, delete race) and an operation
 * that is already gone.
 */
export const waitForOperation = (operation: looker.Operation, options?: { notFoundOk?: boolean }) =>
  waitForGcpOperation(operation, (name) => looker.getProjectsLocationsOperations({ name }), {
    budget: "30 minutes",
    interval: "10 seconds",
  }).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 || (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );
