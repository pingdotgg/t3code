import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface RevokeSubscriptionRequest extends Omit<
  datazone.RevokeSubscriptionInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:RevokeSubscription`.
 *
 * Revokes an approved subscription in the bound domain, optionally retaining already-granted permissions. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.RevokeSubscriptionHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example Revoke a Subscription
 * ```typescript
 * // init — bind the operation to the domain
 * const revokeSubscription = yield* AWS.DataZone.RevokeSubscription(domain);
 *
 * // runtime
 * yield* revokeSubscription({ identifier: subscriptionId, retainPermissions: false });
 * ```
 */
export interface RevokeSubscription extends Binding.Service<
  RevokeSubscription,
  "AWS.DataZone.RevokeSubscription",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: RevokeSubscriptionRequest,
    ) => Effect.Effect<
      datazone.RevokeSubscriptionOutput,
      datazone.RevokeSubscriptionError
    >
  >
> {}
export const RevokeSubscription = Binding.Service<RevokeSubscription>(
  "AWS.DataZone.RevokeSubscription",
);
