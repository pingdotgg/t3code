import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface AcceptSubscriptionRequestRequest extends Omit<
  datazone.AcceptSubscriptionRequestInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:AcceptSubscriptionRequest`.
 *
 * Approves a pending subscription request in the bound domain — the core of an automated approval workflow. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.AcceptSubscriptionRequestHttp)`.
 * @binding
 * @section Subscription Workflows
 * @example Auto-approve a Request
 * ```typescript
 * // init — bind the operation to the domain
 * const acceptSubscriptionRequest = yield* AWS.DataZone.AcceptSubscriptionRequest(domain);
 *
 * // runtime
 * yield* acceptSubscriptionRequest({ identifier: requestId, decisionComment: "auto-approved" });
 * ```
 */
export interface AcceptSubscriptionRequest extends Binding.Service<
  AcceptSubscriptionRequest,
  "AWS.DataZone.AcceptSubscriptionRequest",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: AcceptSubscriptionRequestRequest,
    ) => Effect.Effect<
      datazone.AcceptSubscriptionRequestOutput,
      datazone.AcceptSubscriptionRequestError
    >
  >
> {}
export const AcceptSubscriptionRequest =
  Binding.Service<AcceptSubscriptionRequest>(
    "AWS.DataZone.AcceptSubscriptionRequest",
  );
