import * as translate from "@distilled.cloud/gcp/translate_v3";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { OperationFailed, waitForOperation as waitForGcpOperation } from "../Operation.ts";

/**
 * Translate reports some failures (e.g. a model created from an empty
 * dataset) as `done: true` with the error in `metadata.error` and no
 * top-level `error`.
 */
const metadataFailure = (operation: translate.Operation) => {
  const error = operation.metadata?.error;
  if (!Predicate.isObject(error)) return undefined;
  const code =
    Predicate.hasProperty(error, "code") && Predicate.isNumber(error.code) ? error.code : undefined;
  const message =
    Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
      ? error.message
      : "operation failed";
  return new OperationFailed({
    operation: operation.name ?? "",
    code,
    reason: undefined,
    message,
  });
};

/**
 * Wait for a Translate long-running operation, then re-read it so the
 * returned operation carries its `response`. Model create/delete and
 * glossary create/delete are LROs; Adaptive MT datasets and glossary
 * entries are synchronous. ALREADY_EXISTS (code 6) counts as success
 * (create race); with `notFoundOk`, so does NOT_FOUND (code 5, delete race)
 * and an operation that is already gone.
 */
export const waitForOperation = (
  operation: translate.Operation,
  options?: { notFoundOk?: boolean; budget?: Duration.Input },
) =>
  waitForGcpOperation(operation, (name) => translate.getProjectsLocationsOperations({ name }), {
    budget: options?.budget ?? "10 minutes",
  }).pipe(
    Effect.flatMap(() =>
      operation.name
        ? translate.getProjectsLocationsOperations({ name: operation.name })
        : Effect.succeed(operation),
    ),
    Effect.flatMap((done) => {
      const failed = metadataFailure(done);
      return failed ? Effect.fail(failed) : Effect.succeed(done);
    }),
    Effect.catchIf(
      (error) =>
        (error._tag === "GCP.OperationFailed" &&
          (error.code === 6 || (options?.notFoundOk === true && error.code === 5))) ||
        (options?.notFoundOk === true && error._tag === "NotFound"),
      () => Effect.succeed(operation),
    ),
  );
