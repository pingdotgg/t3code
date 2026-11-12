import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseOperationName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const appsAt = parts.indexOf("apps");
  const operationsAt = parts.lastIndexOf("operations");
  return {
    appsId: appsAt >= 0 ? parts[appsAt + 1] : undefined,
    operationsId: operationsAt >= 0 ? parts[operationsAt + 1] : lastSegment(name),
  };
};

/**
 * Wait for an App Engine operation. Version deploys take several minutes.
 * `notFoundOk` accepts an operation that finished with `NOT_FOUND` (5) or
 * has itself been garbage-collected.
 */
export const waitForOperation = (
  operation: appengine.Operation,
  options: { appsId: string; notFoundOk?: boolean },
) =>
  waitForGcpOperation(
    operation,
    (name) => {
      const parsed = parseOperationName(name);
      return appengine
        .getAppsOperations({
          appsId: parsed.appsId ?? options.appsId,
          operationsId: parsed.operationsId ?? lastSegment(name),
        })
        .pipe(
          Effect.catchTag("NotFound", (error) =>
            options.notFoundOk === true
              ? Effect.succeed<appengine.Operation>({ name, done: true })
              : Effect.fail(error),
          ),
        );
    },
    { budget: "20 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" && options.notFoundOk === true && error.code === 5,
      () => Effect.void,
    ),
    Effect.asVoid,
  );
