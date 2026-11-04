import * as observability from "@distilled.cloud/gcp/observability_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/** Wait for an operation through the shared GCP waiter. */
export const waitForOperation = (
  operation: observability.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      observability
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<observability.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    // ALREADY_EXISTS (6): a concurrent create won the race. NOT_FOUND (5)
    // is success for a delete.
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        ((options?.alreadyExistsOk !== false && error.code === 6) ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    // Re-read the finished operation for its typed response and metadata.
    Effect.flatMap(() =>
      operation.name === undefined || operation.name.length === 0
        ? Effect.succeed(operation)
        : observability
            .getProjectsLocationsOperations({ name: operation.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(operation))),
    ),
  );
