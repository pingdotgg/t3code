import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServiceOperations`.
 *
 * Lists the operations of a discovered service that were invoked during a
 * time range. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceOperationsHttp)`.
 * @binding
 * @section Exploring the Service Topology
 * @example List a Service's Operations
 * ```typescript
 * // init — account-level, no resource argument
 * const listServiceOperations =
 *   yield* AWS.ApplicationSignals.ListServiceOperations();
 *
 * // runtime
 * const page = yield* listServiceOperations({
 *   StartTime: new Date(Date.now() - 3600_000),
 *   EndTime: new Date(),
 *   KeyAttributes: {
 *     Type: "Service",
 *     Name: "checkout-service",
 *     Environment: "eks:prod",
 *   },
 * });
 * ```
 */
export interface ListServiceOperations extends Binding.Service<
  ListServiceOperations,
  "AWS.ApplicationSignals.ListServiceOperations",
  () => Effect.Effect<
    (
      request: appsignals.ListServiceOperationsInput,
    ) => Effect.Effect<
      appsignals.ListServiceOperationsOutput,
      appsignals.ListServiceOperationsError
    >
  >
> {}

export const ListServiceOperations = Binding.Service<ListServiceOperations>(
  "AWS.ApplicationSignals.ListServiceOperations",
);
