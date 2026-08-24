import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface UpdateUsageRequest extends Omit<
  ag.UpdateUsageRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for granting a temporary quota extension to an API key
 * on a {@link UsagePlan} (`apigateway:PATCH` on
 * `/usageplans/{id}/keys/{keyId}/usage`).
 *
 * Provide `ApiGateway.UpdateUsageHttp` on the Function effect to implement
 * the binding.
 *
 * @binding
 * @section Metering usage
 * @example Extend a key's remaining quota
 * ```typescript
 * // init
 * const updateUsage = yield* ApiGateway.UpdateUsage(plan);
 *
 * // runtime
 * yield* updateUsage({
 *   keyId,
 *   patchOperations: [
 *     { op: "replace", path: "/remaining", value: "500" },
 *   ],
 * });
 * ```
 */
export interface UpdateUsage extends Binding.Service<
  UpdateUsage,
  "AWS.ApiGateway.UpdateUsage",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: UpdateUsageRequest,
    ) => Effect.Effect<ag.Usage, ag.UpdateUsageError>
  >
> {}
export const UpdateUsage = Binding.Service<UpdateUsage>(
  "AWS.ApiGateway.UpdateUsage",
);
