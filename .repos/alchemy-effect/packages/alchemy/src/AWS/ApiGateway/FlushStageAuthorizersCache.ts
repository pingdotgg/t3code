import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * Runtime binding for flushing a stage's authorizer result cache
 * (`apigateway:DELETE` on `/restapis/{id}/stages/{name}/cache/authorizers`).
 *
 * Bind a {@link Stage} inside a function runtime to drop cached authorizer
 * verdicts — e.g. immediately revoking access after a permission change,
 * without waiting out `authorizerResultTtl`. Provide
 * `ApiGateway.FlushStageAuthorizersCacheHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Flushing caches
 * @example Revoke cached authorizer verdicts
 * ```typescript
 * // init
 * const flushAuthorizers = yield* ApiGateway.FlushStageAuthorizersCache(stage);
 *
 * // runtime
 * yield* flushAuthorizers();
 * ```
 */
export interface FlushStageAuthorizersCache extends Binding.Service<
  FlushStageAuthorizersCache,
  "AWS.ApiGateway.FlushStageAuthorizersCache",
  <S extends ApiGatewayStage>(
    stage: S,
  ) => Effect.Effect<
    () => Effect.Effect<
      ag.FlushStageAuthorizersCacheResponse,
      ag.FlushStageAuthorizersCacheError
    >
  >
> {}
export const FlushStageAuthorizersCache =
  Binding.Service<FlushStageAuthorizersCache>(
    "AWS.ApiGateway.FlushStageAuthorizersCache",
  );
