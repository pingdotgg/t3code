import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServiceDependencies`.
 *
 * Lists the dependencies (AWS services, resources, and third-party services)
 * that a discovered service's operations connect with. Provide the
 * implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceDependenciesHttp)`.
 * @binding
 * @section Exploring the Service Topology
 * @example List a Service's Dependencies
 * ```typescript
 * // init — account-level, no resource argument
 * const listServiceDependencies =
 *   yield* AWS.ApplicationSignals.ListServiceDependencies();
 *
 * // runtime
 * const page = yield* listServiceDependencies({
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
export interface ListServiceDependencies extends Binding.Service<
  ListServiceDependencies,
  "AWS.ApplicationSignals.ListServiceDependencies",
  () => Effect.Effect<
    (
      request: appsignals.ListServiceDependenciesInput,
    ) => Effect.Effect<
      appsignals.ListServiceDependenciesOutput,
      appsignals.ListServiceDependenciesError
    >
  >
> {}

export const ListServiceDependencies = Binding.Service<ListServiceDependencies>(
  "AWS.ApplicationSignals.ListServiceDependencies",
);
