import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListEntityEvents`.
 *
 * Lists change events (deployments, configuration changes, and other
 * state-changing activities) for a specific entity. Provide the
 * implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListEntityEventsHttp)`.
 * @binding
 * @section Tracking Changes
 * @example List an Entity's Change Events
 * ```typescript
 * // init — account-level, no resource argument
 * const listEntityEvents = yield* AWS.ApplicationSignals.ListEntityEvents();
 *
 * // runtime
 * const page = yield* listEntityEvents({
 *   Entity: {
 *     Type: "Service",
 *     Name: "checkout-service",
 *     Environment: "eks:prod",
 *   },
 *   StartTime: new Date(Date.now() - 24 * 3600_000),
 *   EndTime: new Date(),
 * });
 * ```
 */
export interface ListEntityEvents extends Binding.Service<
  ListEntityEvents,
  "AWS.ApplicationSignals.ListEntityEvents",
  () => Effect.Effect<
    (
      request: appsignals.ListEntityEventsInput,
    ) => Effect.Effect<
      appsignals.ListEntityEventsOutput,
      appsignals.ListEntityEventsError
    >
  >
> {}

export const ListEntityEvents = Binding.Service<ListEntityEvents>(
  "AWS.ApplicationSignals.ListEntityEvents",
);
