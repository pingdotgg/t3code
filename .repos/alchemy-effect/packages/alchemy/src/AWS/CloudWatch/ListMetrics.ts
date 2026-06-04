import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListMetricsRequest extends cloudwatch.ListMetricsInput {}

/**
 * Runtime binding for `cloudwatch:ListMetrics`.
 */
export class ListMetrics extends Binding.Service<
  ListMetrics,
  () => Effect.Effect<
    (
      request?: ListMetricsRequest,
    ) => Effect.Effect<
      cloudwatch.ListMetricsOutput,
      cloudwatch.ListMetricsError
    >
  >
>()("AWS.CloudWatch.ListMetrics") {}

export const ListMetricsLive = Layer.effect(
  ListMetrics,
  Effect.gen(function* () {
    const Policy = yield* ListMetricsPolicy;
    const listMetrics = yield* cloudwatch.listMetrics;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: ListMetricsRequest = {}) {
        return yield* listMetrics(request);
      });
    });
  }),
);

export class ListMetricsPolicy extends Binding.Policy<
  ListMetricsPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.ListMetrics") {}

export const ListMetricsPolicyLive = ListMetricsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.ListMetrics())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["cloudwatch:ListMetrics"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListMetricsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
