import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconnect:ListEntitlements`.
 *
 * Enumerates the entitlements that have been granted TO this account
 * (the subscriber side of content sharing) — e.g. to discover new
 * entitlement ARNs a distributor has shared so a flow source can be
 * provisioned from them. One page per call — pass `NextToken` from the
 * previous response to continue. Account-level: the deploy-time grant is
 * `mediaconnect:ListEntitlements` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.ListEntitlementsHttp)`.
 * @binding
 * @section Managing Entitlements
 * @example Discover Entitlements Granted to This Account
 * ```typescript
 * // init — bind the account-level operation
 * const listEntitlements = yield* AWS.MediaConnect.ListEntitlements();
 *
 * // runtime
 * const { Entitlements } = yield* listEntitlements();
 * ```
 */
export interface ListEntitlements extends Binding.Service<
  ListEntitlements,
  "AWS.MediaConnect.ListEntitlements",
  () => Effect.Effect<
    (
      request?: mediaconnect.ListEntitlementsRequest,
    ) => Effect.Effect<
      mediaconnect.ListEntitlementsResponse,
      mediaconnect.ListEntitlementsError
    >
  >
> {}
export const ListEntitlements = Binding.Service<ListEntitlements>(
  "AWS.MediaConnect.ListEntitlements",
);
