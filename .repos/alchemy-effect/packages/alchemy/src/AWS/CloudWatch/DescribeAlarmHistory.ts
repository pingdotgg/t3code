import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeAlarmHistoryRequest
  extends cloudwatch.DescribeAlarmHistoryInput {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmHistory`.
 */
export class DescribeAlarmHistory extends Binding.Service<
  DescribeAlarmHistory,
  () => Effect.Effect<
    (
      request?: DescribeAlarmHistoryRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmHistoryOutput,
      cloudwatch.DescribeAlarmHistoryError
    >
  >
>()("AWS.CloudWatch.DescribeAlarmHistory") {}

export const DescribeAlarmHistoryLive = Layer.effect(
  DescribeAlarmHistory,
  Effect.gen(function* () {
    const Policy = yield* DescribeAlarmHistoryPolicy;
    const describeAlarmHistory = yield* cloudwatch.describeAlarmHistory;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request: DescribeAlarmHistoryRequest = {}) {
        return yield* describeAlarmHistory(request);
      });
    });
  }),
);

export class DescribeAlarmHistoryPolicy extends Binding.Policy<
  DescribeAlarmHistoryPolicy,
  () => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeAlarmHistory") {}

export const DescribeAlarmHistoryPolicyLive =
  DescribeAlarmHistoryPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmHistory())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DescribeAlarmHistory"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeAlarmHistoryPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
