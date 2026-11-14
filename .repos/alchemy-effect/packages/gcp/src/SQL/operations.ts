import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";

const lastSegment = (value: string | undefined) => {
  const parts = (value ?? "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
};

const operationNameOf = (operation: sqladmin.Operation) =>
  lastSegment(operation.name) || lastSegment(operation.selfLink);

/**
 * Wait for a Cloud SQL admin operation and return the finished operation.
 *
 * An operation whose error code (`errors[].code`) says the target already
 * existed counts as done (a lost create race). With `notFoundOk`, one whose
 * target was already gone — or whose operation record is gone — counts as
 * done too (a lost delete race).
 */
export const waitForSqlOperation = (
  project: string,
  operation: sqladmin.Operation,
  options: { budget: Duration.Input; notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operationNameOf(operation);
    const get = (operationName: string) =>
      sqladmin.getOperations({ project, operation: operationName });
    yield* waitForGcpOperation({ ...operation, name }, get, {
      budget: options.budget,
      interval: "10 seconds",
    }).pipe(
      Effect.catchTags({
        "GCP.OperationFailed": (error) => {
          const code = (error.reason ?? "").toUpperCase();
          return code.includes("ALREADY_EXISTS") ||
            (options.notFoundOk === true && code.includes("NOT_FOUND"))
            ? Effect.void
            : Effect.fail(error);
        },
        NotFound: (error) => (options.notFoundOk === true ? Effect.void : Effect.fail(error)),
      }),
    );
    if (operation.status === "DONE" || name.length === 0) return operation;
    return yield* get(name).pipe(
      Effect.catchTag("NotFound", (error) =>
        options.notFoundOk === true ? Effect.succeed(operation) : Effect.fail(error),
      ),
    );
  });

/**
 * Cloud SQL answers `SqlInstanceNotAuthorized` (403) both for children of an
 * instance that does not exist and for callers without permission. Recover
 * with `onMissing` only after `getInstances` confirms the instance is gone
 * (404); otherwise the original error stands.
 */
export const recoverIfInstanceMissing =
  <B>(project: string, instance: string, onMissing: () => B) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is Extract<E, { readonly _tag: "SqlInstanceNotAuthorized" }> =>
          error._tag === "SqlInstanceNotAuthorized",
        (error) =>
          sqladmin.getInstances({ project, instance }).pipe(
            Effect.flatMap(() => Effect.fail(error)),
            Effect.catchTag("NotFound", () => Effect.succeed(onMissing())),
          ),
      ),
    );
