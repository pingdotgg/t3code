import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsagePlanKeyRequest extends Omit<
  ag.GetUsagePlanKeyRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for reading a single API key enrolled in a
 * {@link UsagePlan} (`apigateway:GET` on `/usageplans/{id}/keys/{keyId}`).
 *
 * Provide `ApiGateway.GetUsagePlanKeyHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Managing plan keys
 * @example Check a key's enrollment
 * ```typescript
 * // init
 * const getUsagePlanKey = yield* ApiGateway.GetUsagePlanKey(plan);
 *
 * // runtime
 * const enrolled = yield* getUsagePlanKey({ keyId }).pipe(
 *   Effect.map(() => true),
 *   Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
 * );
 * ```
 */
export interface GetUsagePlanKey extends Binding.Service<
  GetUsagePlanKey,
  "AWS.ApiGateway.GetUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: GetUsagePlanKeyRequest,
    ) => Effect.Effect<ag.UsagePlanKey, ag.GetUsagePlanKeyError>
  >
> {}
export const GetUsagePlanKey = Binding.Service<GetUsagePlanKey>(
  "AWS.ApiGateway.GetUsagePlanKey",
);
