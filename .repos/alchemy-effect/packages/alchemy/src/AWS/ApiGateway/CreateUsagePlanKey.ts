import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface CreateUsagePlanKeyRequest extends Omit<
  ag.CreateUsagePlanKeyRequest,
  "usagePlanId" | "keyType"
> {
  /**
   * Type of the key being enrolled.
   * @default "API_KEY"
   */
  keyType?: string;
}

/**
 * Runtime binding for enrolling an API key in a {@link UsagePlan}
 * (`apigateway:POST` on `/usageplans/{id}/keys`).
 *
 * The core of a self-service API-key onboarding flow: issue a key with
 * `ApiGateway.CreateApiKey`, then attach it to the plan that throttles
 * and meters it. Provide `ApiGateway.CreateUsagePlanKeyHttp` on the
 * Function effect to implement the binding.
 *
 * @binding
 * @section Managing plan keys
 * @example Enroll a freshly issued key
 * ```typescript
 * // init
 * const createApiKey = yield* ApiGateway.CreateApiKey();
 * const createUsagePlanKey = yield* ApiGateway.CreateUsagePlanKey(plan);
 *
 * // runtime
 * const key = yield* createApiKey({ name: customerId, enabled: true });
 * yield* createUsagePlanKey({ keyId: key.id! });
 * ```
 */
export interface CreateUsagePlanKey extends Binding.Service<
  CreateUsagePlanKey,
  "AWS.ApiGateway.CreateUsagePlanKey",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (
      request: CreateUsagePlanKeyRequest,
    ) => Effect.Effect<ag.UsagePlanKey, ag.CreateUsagePlanKeyError>
  >
> {}
export const CreateUsagePlanKey = Binding.Service<CreateUsagePlanKey>(
  "AWS.ApiGateway.CreateUsagePlanKey",
);
