import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:ListServiceQuotas` — list the applied
 * quota values for a service from inside a Function.
 *
 * @binding
 * @section Listing Quotas
 * @example List VPC quotas
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
