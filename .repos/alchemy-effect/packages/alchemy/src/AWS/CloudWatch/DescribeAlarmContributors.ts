import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface DescribeAlarmContributorsRequest extends Omit<
  cloudwatch.DescribeAlarmContributorsInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmContributors`.
 */
export class DescribeAlarmContributors extends Binding.Service<
  DescribeAlarmContributors,
  (
    alarm: AlarmResource,
  ) => Effect.Effect<
    (
      request?: DescribeAlarmContributorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmContributorsOutput,
      cloudwatch.DescribeAlarmContributorsError
    >
  >
>()("AWS.CloudWatch.DescribeAlarmContributors") {}

export const DescribeAlarmContributorsLive = Layer.effect(
  DescribeAlarmContributors,
  Effect.gen(function* () {
    const Policy = yield* DescribeAlarmContributorsPolicy;
    const describeAlarmContributors =
      yield* cloudwatch.describeAlarmContributors;

    return Effect.fn(function* (alarm: AlarmResource) {
      const AlarmName = yield* alarm.alarmName;
      yield* Policy(alarm);

      return Effect.fn(function* (
        request: DescribeAlarmContributorsRequest = {},
      ) {
        return yield* describeAlarmContributors({
          ...request,
          AlarmName: yield* AlarmName,
        });
      });
    });
  }),
);

export class DescribeAlarmContributorsPolicy extends Binding.Policy<
  DescribeAlarmContributorsPolicy,
  (alarm: AlarmResource) => Effect.Effect<void>
>()("AWS.CloudWatch.DescribeAlarmContributors") {}

export const DescribeAlarmContributorsPolicyLive =
  DescribeAlarmContributorsPolicy.layer.succeed(
    Effect.fn(function* (host, alarm) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmContributors(${alarm}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:DescribeAlarmContributors"],
                Resource: [alarm.alarmArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeAlarmContributorsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
