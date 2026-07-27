import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsagePlanKeysRequest extends Omit<
  ag.GetUsagePlanKeysRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for listing the API keys enrolled in a
 * {@link UsagePlan} (`apigateway:GET` on `/usageplans/{id}/keys`).
 *
 * Provide `ApiGateway.GetUsagePlanKeysHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Managing plan keys
 * @example List enrolled keys
 * ```typescript
 * // init
 * const getUsagePlanKeys = yield* ApiGateway.GetUsagePlanKeys(plan);
 *
 * // runtime
 * const page = yield* getUsagePlanKeys({ limit: 100 });
 * ```
 */
export interface GetUsagePlanKeys extends Binding.Service<
  GetUsagePlanKeys,
  "AWS.ApiGateway.GetUsagePlanKeys",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request?: GetUsagePlanKeysRequest,
    ) => Effect.Effect<ag.UsagePlanKeys, ag.GetUsagePlanKeysError>
  >
> {}
export const GetUsagePlanKeys = Binding.Service<GetUsagePlanKeys>(
  "AWS.ApiGateway.GetUsagePlanKeys",
);
