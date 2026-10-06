import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { waitForOperation } from "../Operation.ts";

/**
 * Compute operations settle in seconds; the slowest (managed instance
 * groups, interconnect attachments, VPN gateways, large disks/images)
 * take a few minutes.
 */
const BUDGET = "15 minutes";
const INTERVAL = "2 seconds";

export interface WaitComputeOptions {
  /**
   * Compute error codes (`error.errors[].code`) that mean the desired state
   * already holds — e.g. `RESOURCE_ALREADY_EXISTS` on an insert or
   * `RESOURCE_NOT_FOUND` on a delete. The settled operation is returned
   * instead of failing with `GCP.OperationFailed`.
   */
  readonly ignore?: ReadonlyArray<string>;
}

/** The Compute error codes an operation finished with. */
export const operationErrorCodes = (operation: compute.Operation) =>
  (operation.error?.errors ?? []).flatMap((error) =>
    error.code === undefined ? [] : [error.code],
  );

const settle = <E extends { readonly _tag: string }, R>(
  operation: compute.Operation,
  get: (name: string) => Effect.Effect<compute.Operation, E, R>,
  options: WaitComputeOptions | undefined,
) =>
  Effect.suspend(() => {
    let last = operation;
    const ignore = options?.ignore ?? [];
    return waitForOperation(
      operation,
      (name) =>
        get(name).pipe(
          // A freshly started operation can 404 for a moment.
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            times: 5,
            schedule: Schedule.exponential("250 millis"),
          }),
          Effect.tap((current) =>
            Effect.sync(() => {
              last = current;
            }),
          ),
        ),
      { budget: BUDGET, interval: INTERVAL },
    ).pipe(
      Effect.map(() => last),
      Effect.catchIf(
        (error) =>
          error._tag === "GCP.OperationFailed" &&
          operationErrorCodes(last).some((code) => ignore.includes(code)),
        () => Effect.succeed(last),
      ),
    );
  });

/** Wait for a zonal Compute operation. Fails with `GCP.OperationFailed` if it errored. */
export const waitZoneOperation = (
  project: string,
  zone: string,
  operation: compute.Operation,
  options?: WaitComputeOptions,
) =>
  settle(
    operation,
    (name) => compute.getZoneOperations({ project, zone, operation: name }),
    options,
  );

/** Wait for a regional Compute operation. Fails with `GCP.OperationFailed` if it errored. */
export const waitRegionOperation = (
  project: string,
  region: string,
  operation: compute.Operation,
  options?: WaitComputeOptions,
) =>
  settle(
    operation,
    (name) => compute.getRegionOperations({ project, region, operation: name }),
    options,
  );

/** Wait for a global Compute operation. Fails with `GCP.OperationFailed` if it errored. */
export const waitGlobalOperation = (
  project: string,
  operation: compute.Operation,
  options?: WaitComputeOptions,
) =>
  settle(
    operation,
    (name) => compute.getGlobalOperations({ project, operation: name }),
    options,
  );

/**
 * Wait for an organization-scoped Compute operation (hierarchical firewall
 * and security policies). Fails with `GCP.OperationFailed` if it errored.
 */
export const waitOrganizationOperation = (
  operation: compute.Operation,
  parentId: string | undefined,
  options?: WaitComputeOptions,
) =>
  settle(
    operation,
    (name) =>
      compute.getGlobalOrganizationOperations({ operation: name, parentId }),
    options,
  );
