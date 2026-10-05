import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

export const resourceNameFromOperation = (
  operation: retail.GoogleLongrunningOperation,
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

const getOperation = (name: string) =>
  name.includes("/catalogs/")
    ? retail.getProjectsLocationsCatalogsOperations({ name })
    : name.includes("/locations/")
      ? retail.getProjectsLocationsOperations({ name })
      : retail.getProjectsOperations({ name });

/**
 * Wait for a Retail operation (model creation takes several minutes).
 * ALREADY_EXISTS (code 6) counts as success (create race); with
 * `notFoundOk`, so does NOT_FOUND (code 5, delete race) and an operation
 * that is already gone.
 */
export const waitForOperation = (
  operation: retail.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
) =>
  waitForGcpOperation(operation, getOperation, { budget: "30 minutes" }).pipe(
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 ||
            (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );
