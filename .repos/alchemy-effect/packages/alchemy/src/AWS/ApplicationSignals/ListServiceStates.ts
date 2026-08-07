import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServiceStates`.
 *
 * Returns the last deployment and other change states of discovered
 * services — visibility into recent changes for troubleshooting and change
 * correlation. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceStatesHttp)`.
 * @binding
 * @section Tracking Changes
 * @example List Recent Service States
 * ```typescript
 * // init — account-level, no resource argument
 * const listServiceStates = yield* AWS.ApplicationSignals.ListServiceStates();
 *
 * // runtime
 * const page = yield* listServiceStates({
 *   StartTime: new Date(Date.now() - 24 * 3600_000),
 *   EndTime: new Date(),
 * });
 * ```
 */
export interface ListServiceStates extends Binding.Service<
  ListServiceStates,
  "AWS.ApplicationSignals.ListServiceStates",
  () => Effect.Effect<
    (
      request: appsignals.ListServiceStatesInput,
    ) => Effect.Effect<
      appsignals.ListServiceStatesOutput,
      appsignals.ListServiceStatesError
    >
  >
> {}

export const ListServiceStates = Binding.Service<ListServiceStates>(
  "AWS.ApplicationSignals.ListServiceStates",
);
