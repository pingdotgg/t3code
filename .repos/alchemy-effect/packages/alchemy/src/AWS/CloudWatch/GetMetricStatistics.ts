import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface GetMetricStatisticsRequest
  extends cloudwatch.GetMetricStatisticsInput {}

/**
 * Runtime binding for `cloudwatch:GetMetricStatistics`.
 */
export class GetMetricStatistics extends Binding.Service<
  GetMetricStatistics,
  () => Effect.Effect<
    (
      request: GetMetricStatisticsRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStatisticsOutput,
      cloudwatch.GetMetricStatisticsError
    >
  >
>()("AWS.CloudWatch.GetMetricStatistics") {}

export const GetMetricStatisticsLive = Layer.effect(
  GetMetricStatistics,
  Effect.gen(function* () {
    const Policy = yield* GetMetricStatisticsPolicy;
    const getMetricStatistics = yield* cloudwatch.getMetricStatistics;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: GetMetricStatisticsRequest) {
        return yield* getMetricStatistics(request);
      });
    });
  }),
);

export class GetMetricStatisticsPolicy extends Binding.Policy<
  GetMetricStatisticsPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.GetMetricStatistics") {}

export const GetMetricStatisticsPolicyLive =
  GetMetricStatisticsPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricStatistics())`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:GetMetricStatistics"],
              Resource: ["*"],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `GetMetricStatisticsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
