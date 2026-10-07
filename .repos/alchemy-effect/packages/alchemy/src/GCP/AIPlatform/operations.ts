import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const resourceNameFromOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  const responseName = response?.name;
  if (typeof responseName === "string" && responseName.length > 0) {
    return responseName;
  }
  const metadata = operation.metadata;
  const target = metadata?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  return undefined;
};

/**
 * Wait for a Vertex AI long-running operation and return the finished
 * operation (so callers can read its `response`). Index deploys and
 * feature-store provisioning take up to ~30 minutes.
 *
 * An operation that failed with ALREADY_EXISTS (6) counts as done (a lost
 * create race). With `notFoundOk`, NOT_FOUND (5) — or an operation record
 * that is gone — counts as done too (a lost delete race).
 */
export const waitForOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const get = (name: string) =>
      aiplatform.getProjectsLocationsOperations({ name });
    const finished = yield* waitForGcpOperation(operation, get, {
      budget: "30 minutes",
    }).pipe(
      Effect.as(true),
      Effect.catchTag("GCP.OperationFailed", (error) =>
        error.code === 6 || (options?.notFoundOk === true && error.code === 5)
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
      Effect.catchTag("NotFound", (error) =>
        options?.notFoundOk === true
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    if (!finished || operation.done === true || !operation.name) {
      return operation;
    }
    return yield* get(operation.name);
  });
