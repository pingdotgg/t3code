import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterApiGatewayBinding } from "./BindingHttp.ts";
import { FlushStageAuthorizersCache } from "./FlushStageAuthorizersCache.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * HTTP implementation of the {@link FlushStageAuthorizersCache} binding.
 * Grants `apigateway:DELETE` on the stage's `/cache/authorizers` path and
 * calls the API with the host Function's credentials.
 */
export const FlushStageAuthorizersCacheHttp = Layer.effect(
  FlushStageAuthorizersCache,
  Effect.gen(function* () {
    const registerApiGatewayBinding = yield* RegisterApiGatewayBinding;
    const flushStageAuthorizersCache = yield* AWSBindings.withCredentials(
      ag.flushStageAuthorizersCache,
    );
    return Effect.fn(function* <S extends ApiGatewayStage>(stage: S) {
      const RestApiId = yield* stage.restApiId;
      const StageName = yield* stage.stageName;
      yield* registerApiGatewayBinding({
        cap: "AWS.ApiGateway.FlushStageAuthorizersCache",
        target: stage,
        verb: "DELETE",
        paths: (region) => [
          Output.interpolate`arn:aws:apigateway:${region}::/restapis/${stage.restApiId}/stages/${stage.stageName}/cache/authorizers`,
        ],
      });
      return Effect.fn(`AWS.ApiGateway.FlushStageAuthorizersCache(${stage.LogicalId})`)(
        function* () {
          return yield* flushStageAuthorizersCache({
            restApiId: yield* RestApiId,
            stageName: yield* StageName,
          });
        },
      );
    });
  }),
);
