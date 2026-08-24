import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:GetServiceQuota` — read the applied
 * value of any Service Quotas quota (account-level or resource-level) from
 * inside a Function.
 *
 * Service Quotas is a read-mostly control-plane service with no resource to
 * manage for reads: the binding takes no arguments and grants the function
 * `servicequotas:GetServiceQuota` (the action has no resource-level IAM).
 * Pass the raw distilled request — no marshalling.
 *
 * @binding
 * @section Reading Quotas
 * @example Read the Lambda concurrent-executions quota
 * ```typescript
 * // init
 * const getServiceQuota = yield* AWS.ServiceQuotas.GetServiceQuota();
 *
 * // runtime
 * const { Quota } = yield* getServiceQuota({
 *   ServiceCode: "lambda",
 *   QuotaCode: "L-B99A9384",
 * });
 * const applied = Quota?.Value;
 * ```
 */
export interface GetServiceQuota extends Binding.Service<
  GetServiceQuota,
  "AWS.ServiceQuotas.GetServiceQuota",
  () => Effect.Effect<
    (
      request: servicequotas.GetServiceQuotaRequest,
    ) => Effect.Effect<
      servicequotas.GetServiceQuotaResponse,
      servicequotas.GetServiceQuotaError
    >
  >
> {}
export const GetServiceQuota = Binding.Service<GetServiceQuota>(
  "AWS.ServiceQuotas.GetServiceQuota",
);
