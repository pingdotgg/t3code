import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicequotas:ListServices` — list the services that
 * integrate with Service Quotas (and their service codes) from inside a
 * Function.
 *
 * @binding
 * @section Listing Quotas
 * @example Discover service codes
 * ```typescript
 * // init
 * const listServices = yield* AWS.ServiceQuotas.ListServices();
 *
 * // runtime
 * const { Services } = yield* listServices({ MaxResults: 100 });
 * const lambda = Services?.find((s) => s.ServiceCode === "lambda");
 * ```
 */
export interface ListServices extends Binding.Service<
  ListServices,
  "AWS.ServiceQuotas.ListServices",
  () => Effect.Effect<
    (
      request?: servicequotas.ListServicesRequest,
    ) => Effect.Effect<
      servicequotas.ListServicesResponse,
      servicequotas.ListServicesError
    >
  >
> {}
export const ListServices = Binding.Service<ListServices>(
  "AWS.ServiceQuotas.ListServices",
);
