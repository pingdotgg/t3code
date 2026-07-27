import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * Runtime binding for flushing a stage's response cache
 * (`apigateway:DELETE` on `/restapis/{id}/stages/{name}/cache/data`).
 *
 * Bind a {@link Stage} inside a function runtime to invalidate cached
 * responses after a content update. Provide
 * `ApiGateway.FlushStageCacheHttp` on the Function effect to implement the
 * binding.
 *
 * @binding
 * @section Flushing caches
 * @example Invalidate the stage cache after a write
 * ```typescript
 * // init
 * const flushStageCache = yield* ApiGateway.FlushStageCache(stage);
 *
 * // runtime
 * yield* flushStageCache();
 * ```
 */
export interface FlushStageCache extends Binding.Service<
  FlushStageCache,
  "AWS.ApiGateway.FlushStageCache",
  <S extends ApiGatewayStage>(
    stage: S,
  ) => Effect.Effect<
    () => Effect.Effect<ag.FlushStageCacheResponse, ag.FlushStageCacheError>
  >
> {}
export const FlushStageCache = Binding.Service<FlushStageCache>(
  "AWS.ApiGateway.FlushStageCache",
);
