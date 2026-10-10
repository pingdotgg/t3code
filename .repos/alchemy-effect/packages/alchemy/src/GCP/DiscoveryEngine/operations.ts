import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const resourceNameFromOperation = (
  operation: discoveryengine.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  if (response && typeof response === "object" && "name" in response) {
    const name = (response as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  const metadata = operation.metadata;
  if (metadata && typeof metadata === "object") {
    const record = metadata as { target?: unknown; name?: unknown };
    if (typeof record.target === "string" && record.target.length > 0) {
      return record.target;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return undefined;
};

/**
 * Wait for a Discovery Engine operation; data store and engine creation
 * take a few minutes. ALREADY_EXISTS (code 6) counts as success (create
 * race); with `notFoundOk`, so does NOT_FOUND (code 5, delete race) and an
 * operation that is already gone.
 */
export const waitForOperation = (
  operation: discoveryengine.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => discoveryengine.getProjectsLocationsOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );
