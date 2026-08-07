import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface CreateSubscriptionRequestRequest extends Omit<
  datazone.CreateSubscriptionRequestInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:CreateSubscriptionRequest`.
 *
 * Requests a subscription to a published listing in the bound domain on behalf of a project. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.CreateSubscriptionRequestHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example Request Access to a Listing
 * ```typescript
 * // init — bind the operation to the domain
 * const createSubscriptionRequest = yield* AWS.DataZone.CreateSubscriptionRequest(domain);
 *
 * // runtime
 * yield* createSubscriptionRequest({
 *   subscribedPrincipals: [{ project: { identifier: projectId } }],
 *   subscribedListings: [{ identifier: listingId }],
 *   requestReason: "nightly enrichment job needs read access",
 * });
 * ```
 */
export interface CreateSubscriptionRequest extends Binding.Service<
  CreateSubscriptionRequest,
  "AWS.DataZone.CreateSubscriptionRequest",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: CreateSubscriptionRequestRequest,
    ) => Effect.Effect<
      datazone.CreateSubscriptionRequestOutput,
      datazone.CreateSubscriptionRequestError
    >
  >
> {}
export const CreateSubscriptionRequest =
  Binding.Service<CreateSubscriptionRequest>(
    "AWS.DataZone.CreateSubscriptionRequest",
  );
