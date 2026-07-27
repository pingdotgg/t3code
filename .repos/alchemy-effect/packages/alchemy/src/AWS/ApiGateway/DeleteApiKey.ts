import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DeleteApiKeyRequest extends ag.DeleteApiKeyRequest {}

/**
 * Runtime binding for deleting an API Gateway API key
 * (`apigateway:DELETE` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * Provide `ApiGateway.DeleteApiKeyHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Managing API keys
 * @example Delete a key on account closure
 * ```typescript
 * // init
 * const deleteApiKey = yield* ApiGateway.DeleteApiKey();
 *
 * // runtime
 * yield* deleteApiKey({ apiKey: keyId }).pipe(
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteApiKey extends Binding.Service<
  DeleteApiKey,
  "AWS.ApiGateway.DeleteApiKey",
  () => Effect.Effect<
    (
      request: DeleteApiKeyRequest,
    ) => Effect.Effect<ag.DeleteApiKeyResponse, ag.DeleteApiKeyError>
  >
> {}
export const DeleteApiKey = Binding.Service<DeleteApiKey>(
  "AWS.ApiGateway.DeleteApiKey",
);
