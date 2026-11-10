import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `servicequotas:ListServiceQuotas` — list the applied
 * quota values for a service from inside a Function.
 *
 * ### Listing Quotas
 * **Example:** List VPC quotas
 * ```typescript
 * // init
 * const listServiceQuotas = yield* AWS.ServiceQuotas.ListServiceQuotas();
 *
 * // runtime
 * const { Quotas } = yield* listServiceQuotas({
 *   ServiceCode: "vpc",
 *   MaxResults: 50,
 * });
 * ```
 *
 * @binding
 */
export interface ListServiceQuotas extends Binding.Service<
  ListServiceQuotas,
  "AWS.ServiceQuotas.ListServiceQuotas",
  () => Effect.Effect<
    (
      request: servicequotas.ListServiceQuotasRequest,
    ) => Effect.Effect<
      servicequotas.ListServiceQuotasResponse,
      servicequotas.ListServiceQuotasError
    >
  >
> {}
export const ListServiceQuotas = Binding.Service<ListServiceQuotas>(
  "AWS.ServiceQuotas.ListServiceQuotas",
);
