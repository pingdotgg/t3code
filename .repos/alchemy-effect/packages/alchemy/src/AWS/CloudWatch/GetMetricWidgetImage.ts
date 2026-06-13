import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface GetMetricWidgetImageRequest
  extends cloudwatch.GetMetricWidgetImageInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricWidgetImage`.
 */
export class GetMetricWidgetImage extends Binding.Service<
  GetMetricWidgetImage,
  () => Effect.Effect<
    (
      request: GetMetricWidgetImageRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricWidgetImageOutput,
      cloudwatch.GetMetricWidgetImageError
    >
  >
>()("AWS.CloudWatch.GetMetricWidgetImage") {}

export const GetMetricWidgetImageLive = Layer.effect(
  GetMetricWidgetImage,
  Effect.gen(function* () {
    const Policy = yield* GetMetricWidgetImagePolicy;
    const getMetricWidgetImage = yield* cloudwatch.getMetricWidgetImage;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: GetMetricWidgetImageRequest) {
        return yield* getMetricWidgetImage(request);
      });
    });
  }),
);

export class GetMetricWidgetImagePolicy extends Binding.Policy<
  GetMetricWidgetImagePolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.GetMetricWidgetImage") {}

export const GetMetricWidgetImagePolicyLive =
  GetMetricWidgetImagePolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricWidgetImage())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:GetMetricWidgetImage"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetMetricWidgetImagePolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
