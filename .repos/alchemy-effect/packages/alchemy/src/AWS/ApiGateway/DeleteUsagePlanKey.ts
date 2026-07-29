import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface DeleteUsagePlanKeyRequest extends Omit<
  ag.DeleteUsagePlanKeyRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for removing an API key from a {@link UsagePlan}
 * (`apigateway:DELETE` on `/usageplans/{id}/keys/{keyId}`).
 *
 * Provide `ApiGateway.DeleteUsagePlanKeyHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Managing plan keys
 * @example Unenroll a key on subscription cancellation
 * ```typescript
 * // init
 * const deleteUsagePlanKey = yield* ApiGateway.DeleteUsagePlanKey(plan);
 *
 * // runtime
 * yield* deleteUsagePlanKey({ keyId }).pipe(
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteUsagePlanKey extends Binding.Service<
  DeleteUsagePlanKey,
  "AWS.ApiGateway.DeleteUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: DeleteUsagePlanKeyRequest,
    ) => Effect.Effect<
      ag.DeleteUsagePlanKeyResponse,
      ag.DeleteUsagePlanKeyError
    >
  >
> {}
export const DeleteUsagePlanKey = Binding.Service<DeleteUsagePlanKey>(
  "AWS.ApiGateway.DeleteUsagePlanKey",
);
