import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const getOperation = (name: string) =>
  name.includes("/locations/")
    ? ml.getProjectsLocationsOperations({ name })
    : ml.getProjectsOperations({ name });

/**
 * Wait for an AI Platform (ML Engine) operation. Version deploys take
 * several minutes. An operation that finished with `ALREADY_EXISTS` (6) is
 * a lost create race; `notFoundOk` also accepts `NOT_FOUND` (5).
 */
export const waitForOperation = (
  operation: ml.GoogleLongrunning__Operation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) =>
      getOperation(name).pipe(
        Effect.catchTag("NotFound", (error) =>
          options?.notFoundOk === true
            ? Effect.succeed<ml.GoogleLongrunning__Operation>({
                name,
                done: true,
              })
            : Effect.fail(error),
        ),
      ),
    { budget: "20 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 || (options?.notFoundOk === true && error.code === 5)),
      () => Effect.void,
    ),
    Effect.asVoid,
  );
