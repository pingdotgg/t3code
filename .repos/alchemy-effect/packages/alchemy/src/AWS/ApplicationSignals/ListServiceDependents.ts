import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServiceDependents`.
 *
 * Lists the dependents (other services, Synthetics canaries, RUM app
 * monitors) that invoked a discovered service during a time range. Provide
 * the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceDependentsHttp)`.
 * @binding
 * @section Exploring the Service Topology
 * @example List a Service's Dependents
 * ```typescript
 * // init — account-level, no resource argument
 * const listServiceDependents =
 *   yield* AWS.ApplicationSignals.ListServiceDependents();
 *
 * // runtime
 * const page = yield* listServiceDependents({
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
export interface ListServiceDependents extends Binding.Service<
  ListServiceDependents,
  "AWS.ApplicationSignals.ListServiceDependents",
  () => Effect.Effect<
    (
      request: appsignals.ListServiceDependentsInput,
    ) => Effect.Effect<
      appsignals.ListServiceDependentsOutput,
      appsignals.ListServiceDependentsError
    >
  >
> {}

export const ListServiceDependents = Binding.Service<ListServiceDependents>(
  "AWS.ApplicationSignals.ListServiceDependents",
);
