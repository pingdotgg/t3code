import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeAnomalyDetectorsRequest
  extends cloudwatch.DescribeAnomalyDetectorsInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAnomalyDetectors`.
 */
export class DescribeAnomalyDetectors extends Binding.Service<
  DescribeAnomalyDetectors,
  () => Effect.Effect<
    (
      request?: DescribeAnomalyDetectorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAnomalyDetectorsOutput,
      cloudwatch.DescribeAnomalyDetectorsError
    >
  >
>()("AWS.CloudWatch.DescribeAnomalyDetectors") {}

export const DescribeAnomalyDetectorsLive = Layer.effect(
  DescribeAnomalyDetectors,
  Effect.gen(function* () {
    const Policy = yield* DescribeAnomalyDetectorsPolicy;
    const describeAnomalyDetectors = yield* cloudwatch.describeAnomalyDetectors;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (
        request: DescribeAnomalyDetectorsRequest = {},
      ) {
        return yield* describeAnomalyDetectors(request);
      });
    });
  }),
);

export class DescribeAnomalyDetectorsPolicy extends Binding.Policy<
  DescribeAnomalyDetectorsPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeAnomalyDetectors") {}

export const DescribeAnomalyDetectorsPolicyLive =
  DescribeAnomalyDetectorsPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAnomalyDetectors())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DescribeAnomalyDetectors"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeAnomalyDetectorsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
