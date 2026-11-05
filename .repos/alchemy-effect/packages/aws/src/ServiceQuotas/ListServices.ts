import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `servicequotas:ListServices` — list the services that
 * integrate with Service Quotas (and their service codes) from inside a
 * Function.
 *
 * ### Listing Quotas
 * **Example:** Discover service codes
 * ```typescript
 * // init
 * const listServices = yield* AWS.ServiceQuotas.ListServices();
 *
 * // runtime
 * const { Services } = yield* listServices({ MaxResults: 100 });
 * const lambda = Services?.find((s) => s.ServiceCode === "lambda");
 * ```
 *
 * @binding
 */
export interface ListServices extends Binding.Service<
  ListServices,
  "AWS.ServiceQuotas.ListServices",
  () => Effect.Effect<
    (
      request?: servicequotas.ListServicesRequest,
    ) => Effect.Effect<servicequotas.ListServicesResponse, servicequotas.ListServicesError>
  >
> {}
export const ListServices = Binding.Service<ListServices>("AWS.ServiceQuotas.ListServices");
