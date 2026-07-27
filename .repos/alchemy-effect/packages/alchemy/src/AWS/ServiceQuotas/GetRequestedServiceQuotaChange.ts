import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:GetRequestedServiceQuotaChange` — read
 * the status of a quota increase request from inside a Function (e.g. to
 * poll a request submitted with
 * {@link RequestServiceQuotaIncrease | RequestServiceQuotaIncrease}).
 *
 * @binding
 * @section Quota Increase Requests
 * @example Poll a quota increase request
 * ```typescript
 * // init
 * const getRequestedServiceQuotaChange =
 *   yield* AWS.ServiceQuotas.GetRequestedServiceQuotaChange();
 *
 * // runtime
 * const { RequestedQuota } = yield* getRequestedServiceQuotaChange({
 *   RequestId: requestId,
 * });
 * const status = RequestedQuota?.Status; // PENDING | APPROVED | ...
 * ```
 */
export interface GetRequestedServiceQuotaChange extends Binding.Service<
  GetRequestedServiceQuotaChange,
  "AWS.ServiceQuotas.GetRequestedServiceQuotaChange",
  () => Effect.Effect<
    (
      request: servicequotas.GetRequestedServiceQuotaChangeRequest,
    ) => Effect.Effect<
      servicequotas.GetRequestedServiceQuotaChangeResponse,
      servicequotas.GetRequestedServiceQuotaChangeError
    >
  >
> {}
export const GetRequestedServiceQuotaChange =
  Binding.Service<GetRequestedServiceQuotaChange>(
    "AWS.ServiceQuotas.GetRequestedServiceQuotaChange",
  );
