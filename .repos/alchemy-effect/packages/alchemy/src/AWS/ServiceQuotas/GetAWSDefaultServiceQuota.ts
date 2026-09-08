import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:GetAWSDefaultServiceQuota` — read the
 * AWS default value of a quota (the value that applies when no account
 * override exists) from inside a Function.
 *
 * ### Reading Quotas
 * **Example:** Read the default VPCs-per-region quota
 * ```typescript
 * // init
 * const getAWSDefaultServiceQuota =
 *   yield* AWS.ServiceQuotas.GetAWSDefaultServiceQuota();
 *
 * // runtime
 * const { Quota } = yield* getAWSDefaultServiceQuota({
 *   ServiceCode: "vpc",
 *   QuotaCode: "L-F678F1CE",
 * });
 * const defaultValue = Quota?.Value;
 * ```
 *
 * @binding
 */
export interface GetAWSDefaultServiceQuota extends Binding.Service<
  GetAWSDefaultServiceQuota,
  "AWS.ServiceQuotas.GetAWSDefaultServiceQuota",
  () => Effect.Effect<
    (
      request: servicequotas.GetAWSDefaultServiceQuotaRequest,
    ) => Effect.Effect<
      servicequotas.GetAWSDefaultServiceQuotaResponse,
      servicequotas.GetAWSDefaultServiceQuotaError
    >
  >
> {}
export const GetAWSDefaultServiceQuota =
  Binding.Service<GetAWSDefaultServiceQuota>(
    "AWS.ServiceQuotas.GetAWSDefaultServiceQuota",
  );
