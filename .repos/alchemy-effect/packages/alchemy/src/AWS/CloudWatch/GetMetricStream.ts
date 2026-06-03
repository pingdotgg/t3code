import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { MetricStream } from "./MetricStream.ts";

export interface GetMetricStreamRequest extends Omit<
  cloudwatch.GetMetricStreamInput,
  "Name"
> {}

/**
 * Runtime binding for `cloudwatch:GetMetricStream`.
 */
export class GetMetricStream extends Binding.Service<
  GetMetricStream,
  (
    metricStream: MetricStream,
  ) => Effect.Effect<
    (
      request?: GetMetricStreamRequest,
    ) => Effect.Effect<
      cloudwatch.GetMetricStreamOutput,
      cloudwatch.GetMetricStreamError
    >
  >
>()("AWS.CloudWatch.GetMetricStream") {}

export const GetMetricStreamLive = Layer.effect(
  GetMetricStream,
  Effect.gen(function* () {
    const Policy = yield* GetMetricStreamPolicy;
    const getMetricStream = yield* cloudwatch.getMetricStream;

    return Effect.fn(function* (metricStream: MetricStream) {
      const Name = yield* metricStream.metricStreamName;
      yield* Policy(metricStream);

      return Effect.fn(function* (request: GetMetricStreamRequest = {}) {
        return yield* getMetricStream({
          ...request,
          Name: yield* Name,
        });
      });
    });
  }),
);

export class GetMetricStreamPolicy extends Binding.Policy<
  GetMetricStreamPolicy,
  (metricStream: MetricStream) => Effect.Effect<void>
>()("AWS.CloudWatch.GetMetricStream") {}

export const GetMetricStreamPolicyLive = GetMetricStreamPolicy.layer.succeed(
  Effect.fn(function* (host, metricStream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricStream(${metricStream}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:GetMetricStream"],
              Resource: [metricStream.metricStreamArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `GetMetricStreamPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
