import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:GetService`.
 *
 * Returns information about one service discovered by Application Signals,
 * identified by its `KeyAttributes` (`Type`/`Name`/`Environment`). Provide
 * the implementation with
 * `Effect.provide(AWS.ApplicationSignals.GetServiceHttp)`.
 * @binding
 * @section Discovering Services
 * @example Get a Discovered Service
 * ```typescript
 * // init — account-level, no resource argument
 * const getService = yield* AWS.ApplicationSignals.GetService();
 *
 * // runtime
 * const result = yield* getService({
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
export interface GetService extends Binding.Service<
  GetService,
  "AWS.ApplicationSignals.GetService",
  () => Effect.Effect<
    (
      request: appsignals.GetServiceInput,
    ) => Effect.Effect<appsignals.GetServiceOutput, appsignals.GetServiceError>
  >
> {}

export const GetService = Binding.Service<GetService>(
  "AWS.ApplicationSignals.GetService",
);
