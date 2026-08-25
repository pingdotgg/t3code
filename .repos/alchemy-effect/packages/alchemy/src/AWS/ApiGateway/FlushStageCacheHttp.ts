import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { registerApiGatewayBinding } from "./BindingHttp.ts";
import { FlushStageCache } from "./FlushStageCache.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * HTTP implementation of the {@link FlushStageCache} binding. Grants
 * `apigateway:DELETE` on the stage's `/cache/data` path and calls the API
 * with the host Function's credentials.
 */
export const FlushStageCacheHttp = Layer.effect(
  FlushStageCache,
  Effect.gen(function* () {
    const flushStageCache = yield* ag.flushStageCache;
    return Effect.fn(function* <S extends ApiGatewayStage>(stage: S) {
      const RestApiId = yield* stage.restApiId;
      const StageName = yield* stage.stageName;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.FlushStageCache",
        target: stage,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/restapis/${stage.restApiId}/stages/${stage.stageName}/cache/data`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.FlushStageCache(${stage.LogicalId})`)(
        function* () {
          return yield* flushStageCache({
            restApiId: yield* RestApiId,
            stageName: yield* StageName,
          });
        },
      );
    });
  }),
);
