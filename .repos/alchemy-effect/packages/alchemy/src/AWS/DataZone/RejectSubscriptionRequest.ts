import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface RejectSubscriptionRequestRequest extends Omit<
  datazone.RejectSubscriptionRequestInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:RejectSubscriptionRequest`.
 *
 * Rejects a pending subscription request in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.RejectSubscriptionRequestHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example Reject a Request
 * ```typescript
 * // init — bind the operation to the domain
 * const rejectSubscriptionRequest = yield* AWS.DataZone.RejectSubscriptionRequest(domain);
 *
 * // runtime
 * yield* rejectSubscriptionRequest({ identifier: requestId, decisionComment: "PII policy" });
 * ```
 */
export interface RejectSubscriptionRequest extends Binding.Service<
  RejectSubscriptionRequest,
  "AWS.DataZone.RejectSubscriptionRequest",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: RejectSubscriptionRequestRequest,
    ) => Effect.Effect<
      datazone.RejectSubscriptionRequestOutput,
      datazone.RejectSubscriptionRequestError
    >
  >
> {}
export const RejectSubscriptionRequest =
  Binding.Service<RejectSubscriptionRequest>(
    "AWS.DataZone.RejectSubscriptionRequest",
  );
