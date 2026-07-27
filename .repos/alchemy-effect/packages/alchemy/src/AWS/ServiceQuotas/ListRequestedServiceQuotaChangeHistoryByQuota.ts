import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for
 * `servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota` — list quota
 * increase requests for one specific quota from inside a Function.
 *
 * @binding
 * @section Quota Increase Requests
 * @example List requests for the Lambda concurrency quota
 * ```typescript
 * // init
 * const listRequestedServiceQuotaChangeHistoryByQuota =
 *   yield* AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuota();
 *
 * // runtime
 * const { RequestedQuotas } =
 *   yield* listRequestedServiceQuotaChangeHistoryByQuota({
 *     ServiceCode: "lambda",
 *     QuotaCode: "L-B99A9384",
 *   });
 * ```
 */
export interface ListRequestedServiceQuotaChangeHistoryByQuota extends Binding.Service<
  ListRequestedServiceQuotaChangeHistoryByQuota,
  "AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuota",
  () => Effect.Effect<
    (
      request: servicequotas.ListRequestedServiceQuotaChangeHistoryByQuotaRequest,
    ) => Effect.Effect<
      servicequotas.ListRequestedServiceQuotaChangeHistoryByQuotaResponse,
      servicequotas.ListRequestedServiceQuotaChangeHistoryByQuotaError
    >
  >
> {}
export const ListRequestedServiceQuotaChangeHistoryByQuota =
  Binding.Service<ListRequestedServiceQuotaChangeHistoryByQuota>(
    "AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistoryByQuota",
  );
