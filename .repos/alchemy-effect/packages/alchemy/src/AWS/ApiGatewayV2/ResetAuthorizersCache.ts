import type * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";

/**
 * Runtime binding for resetting a stage's authorizer result cache
 * (`apigateway:DELETE` on `/apis/{apiId}/stages/{stageName}/cache/authorizers`).
 *
 * Bind a {@link Stage} inside a function runtime to drop cached Lambda
 * authorizer verdicts — e.g. immediately revoking access after a
 * permission change, without waiting out `authorizerResultTtl`. Provide
 * `ApiGatewayV2.ResetAuthorizersCacheHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Flushing caches
 * @example Revoke cached authorizer verdicts
 * ```typescript
 * // init
 * const resetAuthorizersCache = yield* ApiGatewayV2.ResetAuthorizersCache(stage);
 *
 * // runtime
 * yield* resetAuthorizersCache();
 * ```
 */
export interface ResetAuthorizersCache extends Binding.Service<
  ResetAuthorizersCache,
  "AWS.ApiGatewayV2.ResetAuthorizersCache",
  <S extends ApiGatewayV2Stage>(
    stage: S,
  ) => Effect.Effect<
    () => Effect.Effect<
      agw2.ResetAuthorizersCacheResponse,
      agw2.ResetAuthorizersCacheError
    >
  >
> {}
export const ResetAuthorizersCache = Binding.Service<ResetAuthorizersCache>(
  "AWS.ApiGatewayV2.ResetAuthorizersCache",
);
