import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeAlarmsForMetricRequest
  extends cloudwatch.DescribeAlarmsForMetricInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmsForMetric`.
 */
export class DescribeAlarmsForMetric extends Binding.Service<
  DescribeAlarmsForMetric,
  () => Effect.Effect<
    (
      request: DescribeAlarmsForMetricRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmsForMetricOutput,
      cloudwatch.DescribeAlarmsForMetricError
    >
  >
>()("AWS.CloudWatch.DescribeAlarmsForMetric") {}

export const DescribeAlarmsForMetricLive = Layer.effect(
  DescribeAlarmsForMetric,
  Effect.gen(function* () {
    const Policy = yield* DescribeAlarmsForMetricPolicy;
    const describeAlarmsForMetric = yield* cloudwatch.describeAlarmsForMetric;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: DescribeAlarmsForMetricRequest) {
        return yield* describeAlarmsForMetric(request);
      });
    });
  }),
);

export class DescribeAlarmsForMetricPolicy extends Binding.Policy<
  DescribeAlarmsForMetricPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeAlarmsForMetric") {}

export const DescribeAlarmsForMetricPolicyLive =
  DescribeAlarmsForMetricPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmsForMetric())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DescribeAlarmsForMetric"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeAlarmsForMetricPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
