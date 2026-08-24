import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:RequestServiceQuotaIncrease` — submit a
 * quota increase request from inside a Function (e.g. automatically request
 * more capacity when utilization approaches the limit).
 *
 * :::caution
 * Submitting a request may open an AWS Support case and cannot be cancelled
 * through the Service Quotas API. For declaratively managed increases prefer
 * the {@link ServiceQuotaIncreaseRequest} resource.
 * :::
 *
 * @binding
 * @section Quota Increase Requests
 * @example Request more concurrent executions
 * ```typescript
 * // init
 * const requestServiceQuotaIncrease =
 *   yield* AWS.ServiceQuotas.RequestServiceQuotaIncrease();
 *
 * // runtime
 * const { RequestedQuota } = yield* requestServiceQuotaIncrease({
 *   ServiceCode: "lambda",
 *   QuotaCode: "L-B99A9384",
 *   DesiredValue: 2000,
 * });
 * const requestId = RequestedQuota?.Id;
 * ```
 */
export interface RequestServiceQuotaIncrease extends Binding.Service<
  RequestServiceQuotaIncrease,
  "AWS.ServiceQuotas.RequestServiceQuotaIncrease",
  () => Effect.Effect<
    (
      request: servicequotas.RequestServiceQuotaIncreaseRequest,
    ) => Effect.Effect<
      servicequotas.RequestServiceQuotaIncreaseResponse,
      servicequotas.RequestServiceQuotaIncreaseError
    >
  >
> {}
export const RequestServiceQuotaIncrease =
  Binding.Service<RequestServiceQuotaIncrease>(
    "AWS.ServiceQuotas.RequestServiceQuotaIncrease",
  );
