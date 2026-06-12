import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface GetMetricDataRequest extends cloudwatch.GetMetricDataInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricData`.
 */
export class GetMetricData extends Binding.Service<
  GetMetricData,
  () => Effect.Effect<
    (
      request: GetMetricDataRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricDataOutput,
      cloudwatch.GetMetricDataError
    >
  >
>()("AWS.CloudWatch.GetMetricData") {}

export const GetMetricDataLive = Layer.effect(
  GetMetricData,
  Effect.gen(function* () {
    const Policy = yield* GetMetricDataPolicy;
    const getMetricData = yield* cloudwatch.getMetricData;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: GetMetricDataRequest) {
        return yield* getMetricData(request);
      });
    });
  }),
);

export class GetMetricDataPolicy extends Binding.Policy<
  GetMetricDataPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.GetMetricData") {}

export const GetMetricDataPolicyLive = GetMetricDataPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricData())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["cloudwatch:GetMetricData"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `GetMetricDataPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
