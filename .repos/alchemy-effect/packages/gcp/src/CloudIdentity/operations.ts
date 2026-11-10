import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class CloudidentityOperationFailed extends Data.TaggedError(
  "GCP.CloudIdentity.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class CloudidentityOperationPending extends Data.TaggedError(
  "GCP.CloudIdentity.OperationPending",
)<{
  operation: string;
}> {}

const alreadyExists = (error: cloudidentity.Status | undefined) => error?.code === 6;

const isNotFoundStatus = (error: cloudidentity.Status | undefined) => error?.code === 5;

export const resourceNameFromOperation = (
  operation: cloudidentity.Operation,
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
  const metadataName = metadata?.name;
  if (typeof metadataName === "string" && metadataName.length > 0) {
    return metadataName;
  }
  return undefined;
};

/**
 * Cloud Identity create/delete/patch return long-running Operations.
 * Distilled does not expose operations.get, so this helper settles
 * immediately when `done` is set and otherwise treats a resource name
 * in `response`/`metadata` as success. Callers poll get/lookup when
 * the operation is still pending.
 */
export const waitForOperation = (
  operation: cloudidentity.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.error) {
      if (alreadyExists(operation.error)) return operation;
      if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
        return operation;
      }
      return yield* new CloudidentityOperationFailed({
        operation: name ?? "",
        message: operation.error.message ?? "operation failed",
      });
    }
    if (operation.done === true) {
      return operation;
    }
    if (resourceNameFromOperation(operation) !== undefined) {
      return operation;
    }
    if (options?.notFoundOk === true) {
      return operation;
    }
    return yield* new CloudidentityOperationPending({
      operation: name ?? "",
    });
  });

export const waitUntilPresent = <A, E, R>(
  fetch: Effect.Effect<A | undefined, E, R>,
  operation = "",
) =>
  fetch.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new CloudidentityOperationPending({ operation }),
    ),
    Effect.retry({
      while: (error) => error instanceof CloudidentityOperationPending,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );
