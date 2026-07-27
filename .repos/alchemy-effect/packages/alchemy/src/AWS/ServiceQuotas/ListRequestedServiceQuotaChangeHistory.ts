import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for
 * `servicequotas:ListRequestedServiceQuotaChangeHistory` — list quota
 * increase requests in the account's 90-day request history from inside a
 * Function, optionally filtered by service or status.
 *
 * @binding
 * @section Quota Increase Requests
 * @example List pending requests
 * ```typescript
 * // init
 * const listRequestedServiceQuotaChangeHistory =
 *   yield* AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistory();
 *
 * // runtime
 * const { RequestedQuotas } = yield* listRequestedServiceQuotaChangeHistory({
 *   Status: "PENDING",
 * });
 * ```
 */
export interface ListRequestedServiceQuotaChangeHistory extends Binding.Service<
  ListRequestedServiceQuotaChangeHistory,
  "AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistory",
  () => Effect.Effect<
    (
      request?: servicequotas.ListRequestedServiceQuotaChangeHistoryRequest,
    ) => Effect.Effect<
      servicequotas.ListRequestedServiceQuotaChangeHistoryResponse,
      servicequotas.ListRequestedServiceQuotaChangeHistoryError
    >
  >
> {}
export const ListRequestedServiceQuotaChangeHistory =
  Binding.Service<ListRequestedServiceQuotaChangeHistory>(
    "AWS.ServiceQuotas.ListRequestedServiceQuotaChangeHistory",
  );
