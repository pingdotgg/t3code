import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetApiKeysRequest extends ag.GetApiKeysRequest {}

/**
 * Runtime binding for listing API Gateway API keys
 * (`apigateway:GET` on `/apikeys`). Account-scoped — takes no resource.
 *
 * Provide `ApiGateway.GetApiKeysHttp` on the Function effect to implement
 * the binding.
 *
 * @binding
 * @section Managing API keys
 * @example Find keys by name prefix
 * ```typescript
 * // init
 * const getApiKeys = yield* ApiGateway.GetApiKeys();
 *
 * // runtime
 * const page = yield* getApiKeys({ nameQuery: "customer-", limit: 100 });
 * ```
 */
export interface GetApiKeys extends Binding.Service<
  GetApiKeys,
  "AWS.ApiGateway.GetApiKeys",
  () => Effect.Effect<
    (
      request?: GetApiKeysRequest,
    ) => Effect.Effect<ag.ApiKeys, ag.GetApiKeysError>
  >
> {}
export const GetApiKeys = Binding.Service<GetApiKeys>(
  "AWS.ApiGateway.GetApiKeys",
);
