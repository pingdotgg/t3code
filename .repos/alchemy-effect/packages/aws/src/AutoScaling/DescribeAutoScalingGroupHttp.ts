import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";
import { DescribeAutoScalingGroup } from "./DescribeAutoScalingGroup.ts";

// Bespoke (not the shared scaffold): `describeAutoScalingGroups` takes the
// group name inside the `AutoScalingGroupNames` array and the client unwraps
// the single-element response.
export const DescribeAutoScalingGroupHttp = Layer.effect(
  DescribeAutoScalingGroup,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describe = yield* AWSBindings.withCredentials(autoscaling.describeAutoScalingGroups);

    return Effect.fn(function* (group: AutoScalingGroup) {
      const AutoScalingGroupName = yield* group.autoScalingGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AutoScaling.DescribeAutoScalingGroup(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["autoscaling:DescribeAutoScalingGroups"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.AutoScaling.DescribeAutoScalingGroup(${group.LogicalId})`)(
        function* () {
          const result = yield* describe({
            AutoScalingGroupNames: [yield* AutoScalingGroupName],
          });
          return result.AutoScalingGroups?.[0];
        },
      );
    });
  }),
);
