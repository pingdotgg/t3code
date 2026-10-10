import * as certificatemanager from "@distilled.cloud/gcp/certificatemanager_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

/**
 * Wait for a Certificate Manager operation. Most operations finish in
 * seconds; managed certificates and issuance configs can take minutes. An
 * operation that finished with `ALREADY_EXISTS` (6) is a lost create race;
 * `notFoundOk` also accepts `NOT_FOUND` (5).
 *
 * NOT exported from `index.ts`.
 */
export const waitForOperation = (
  operation: certificatemanager.Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      certificatemanager
        .getProjectsLocationsOperations({ name })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options?.notFoundOk === true
              ? Effect.succeed<certificatemanager.Operation>({
                  name,
                  done: true,
                })
              : Effect.fail(error),
          ),
        ),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );
