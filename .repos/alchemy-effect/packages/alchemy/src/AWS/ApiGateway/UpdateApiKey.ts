import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface UpdateApiKeyRequest extends ag.UpdateApiKeyRequest {}

/**
 * Runtime binding for patching an API Gateway API key
 * (`apigateway:PATCH` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * Provide `ApiGateway.UpdateApiKeyHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Managing API keys
 * @example Disable a key
 * ```typescript
 * // init
 * const updateApiKey = yield* ApiGateway.UpdateApiKey();
 *
 * // runtime
 * yield* updateApiKey({
 *   apiKey: keyId,
 *   patchOperations: [{ op: "replace", path: "/enabled", value: "false" }],
 * });
 * ```
 */
export interface UpdateApiKey extends Binding.Service<
  UpdateApiKey,
  "AWS.ApiGateway.UpdateApiKey",
  () => Effect.Effect<
    (
      request: UpdateApiKeyRequest,
    ) => Effect.Effect<ag.ApiKey, ag.UpdateApiKeyError>
  >
> {}
export const UpdateApiKey = Binding.Service<UpdateApiKey>(
  "AWS.ApiGateway.UpdateApiKey",
);
