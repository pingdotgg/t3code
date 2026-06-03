import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface PutMetricDataRequest extends cloudwatch.PutMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:PutMetricData`.
 */
export class PutMetricData extends Binding.Service<
  PutMetricData,
  () => Effect.Effect<
    (
      request: PutMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.PutMetricDataResponse,
      cloudwatch.PutMetricDataError
    >
  >
>()("AWS.CloudWatch.PutMetricData") {}

export const PutMetricDataLive = Layer.effect(
  PutMetricData,
  Effect.gen(function* () {
    const Policy = yield* PutMetricDataPolicy;
    const putMetricData = yield* cloudwatch.putMetricData;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: PutMetricDataRequest) {
        return yield* putMetricData(request);
      });
    });
  }),
);

export class PutMetricDataPolicy extends Binding.Policy<
  PutMetricDataPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.PutMetricData") {}

export const PutMetricDataPolicyLive = PutMetricDataPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.PutMetricData())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["cloudwatch:PutMetricData"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutMetricDataPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
