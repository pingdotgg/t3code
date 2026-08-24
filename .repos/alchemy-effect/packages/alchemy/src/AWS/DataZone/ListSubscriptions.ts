import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface ListSubscriptionsRequest extends Omit<
  datazone.ListSubscriptionsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:ListSubscriptions`.
 *
 * Lists subscriptions in the bound domain, optionally by status. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.ListSubscriptionsHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example List Approved Subscriptions
 * ```typescript
 * // init — bind the operation to the domain
 * const listSubscriptions = yield* AWS.DataZone.ListSubscriptions(domain);
 *
 * // runtime
 * const subs = yield* listSubscriptions({ status: "APPROVED" });
 * ```
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.DataZone.ListSubscriptions",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      datazone.ListSubscriptionsOutput,
      datazone.ListSubscriptionsError
    >
  >
> {}
export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.DataZone.ListSubscriptions",
);
