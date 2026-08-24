import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetApiKeyRequest extends ag.GetApiKeyRequest {}

/**
 * Runtime binding for reading a single API Gateway API key
 * (`apigateway:GET` on `/apikeys/{id}`). Account-scoped — takes no
 * resource.
 *
 * With `includeValue: true` the response's `value` is `Redacted<string>`.
 * Provide `ApiGateway.GetApiKeyHttp` on the Function effect to implement
 * the binding.
 *
 * @binding
 * @section Managing API keys
 * @example Look up a key
 * ```typescript
 * // init
 * const getApiKey = yield* ApiGateway.GetApiKey();
 *
 * // runtime
 * const key = yield* getApiKey({ apiKey: keyId });
 * ```
 */
export interface GetApiKey extends Binding.Service<
  GetApiKey,
  "AWS.ApiGateway.GetApiKey",
  () => Effect.Effect<
    (request: GetApiKeyRequest) => Effect.Effect<ag.ApiKey, ag.GetApiKeyError>
  >
> {}
export const GetApiKey = Binding.Service<GetApiKey>("AWS.ApiGateway.GetApiKey");
