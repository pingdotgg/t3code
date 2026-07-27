import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServices`.
 *
 * Lists the services discovered by Application Signals during a time range.
 * Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServicesHttp)`.
 * @binding
 * @section Discovering Services
 * @example List Discovered Services
 * ```typescript
 * // init — account-level, no resource argument
 * const listServices = yield* AWS.ApplicationSignals.ListServices();
 *
 * // runtime
 * const page = yield* listServices({
 *   StartTime: new Date(Date.now() - 3600_000),
 *   EndTime: new Date(),
 * });
 * for (const service of page.ServiceSummaries) {
 *   yield* Effect.log(service.KeyAttributes?.Name);
 * }
 * ```
 */
export interface ListServices extends Binding.Service<
  ListServices,
  "AWS.ApplicationSignals.ListServices",
  () => Effect.Effect<
    (
      request: appsignals.ListServicesInput,
    ) => Effect.Effect<
      appsignals.ListServicesOutput,
      appsignals.ListServicesError
    >
  >
> {}

export const ListServices = Binding.Service<ListServices>(
  "AWS.ApplicationSignals.ListServices",
);
